/*
  Flip Spider - a tiny canvas web game
  Mechanics: Tap / click / press Space to throw a web and vault upward.
  Dodge building gaps, score on each pass. Local high score is saved.
*/

(function () {
  /** Canvas setup */
  const canvas = document.getElementById("game");
  /** @type {CanvasRenderingContext2D} */
  const ctx = canvas.getContext("2d");

  // Logical size kept constant for physics; CSS scales visually
  const VIEW_WIDTH = canvas.width;
  const VIEW_HEIGHT = canvas.height;

  /** Game state */
  const State = {
    Menu: "menu",
    Playing: "playing",
    GameOver: "gameover",
  };
  let gameState = State.Menu;

  /** Player (our web-slinger) */
  const player = {
    x: VIEW_WIDTH * 0.28,
    y: VIEW_HEIGHT * 0.45,
    radius: 18,
    vy: 0,
    alive: true,
    webCooldownMs: 0,
  };

  /** Tunables */
  const physics = {
    gravity: 0.52, // stronger gravity = snappier game feel
    thrust: -9.8, // web impulse upward
    terminalVel: 14,
    floorHeight: 72,
  };

  const obstacles = {
    list: [],
    speed: 3.2,
    minGap: 140,
    maxGap: 185,
    spacing: 220, // horizontal spacing between building pairs
    width: 70,
    lastSpawnX: 0,
  };

  let score = 0;
  let best = Number(localStorage.getItem("flipspider.best") || 0);

  /** Web visual effect */
  let webLine = null; // {x1,y1,x2,y2,life}

  /** Infinite phases (theme + music) */
  let currentPhase = 0;
  let theme = null;

  /** Difficulty */
  const Difficulty = { Easy: "Easy", Medium: "Medium", Hard: "Hard" };
  let selectedDifficulty = Difficulty.Medium;
  // Positive padding makes collisions more forgiving; negative makes harder
  let collisionPadding = 0;

  const DifficultyPresets = {
    [Difficulty.Easy]: {
      speed: 2.6,
      spacing: 280,
      minGap: 180,
      maxGap: 220,
      collisionPadding: 8,
    },
    [Difficulty.Medium]: {
      speed: 3.2,
      spacing: 220,
      minGap: 140,
      maxGap: 185,
      collisionPadding: 0,
    },
    [Difficulty.Hard]: {
      speed: 4.1,
      spacing: 200,
      minGap: 120,
      maxGap: 150,
      collisionPadding: -2,
    },
  };

  /** Audio (MIDI-like punk-ish bgm + hit sfx). Original riff, not from any song. */
  const audio = {
    ctx: null,
    masterGain: null,
    musicGain: null,
    sfxGain: null,
    started: false,
    musicTimer: null,
    // chord (power-chord) oscs
    chordOscs: [],
    chordGain: null,
    // optional lead
    leadOsc: null,
    leadGain: null,
    // noise buffer for simple drums
    noiseBuffer: null,
    currentStep: 0,
    tempo: 170,
    init() {
      if (this.ctx) return;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new Ctx();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.6;
        this.masterGain.connect(this.ctx.destination);

        this.musicGain = this.ctx.createGain();
        this.musicGain.gain.value = 0.2; // low background volume
        this.musicGain.connect(this.masterGain);

        this.sfxGain = this.ctx.createGain();
        this.sfxGain.gain.value = 0.8;
        this.sfxGain.connect(this.masterGain);

        // pre-generate white noise buffer for drums
        const len = this.ctx.sampleRate * 1.0;
        const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        this.noiseBuffer = buf;
      } catch (e) {
        // Audio not available
      }
    },
    ensureRunning() {
      if (!this.ctx) return;
      if (this.ctx.state === "suspended") this.ctx.resume();
    },
    startMusic() {
      if (!this.ctx || this.musicTimer) return;
      this.ensureRunning();
      const ctx = this.ctx;
      // Chord power-chord stack: root, fifth, octave (detuned squares)
      this.chordGain = ctx.createGain();
      this.chordGain.gain.value = 0.0; // envelope each step
      this.chordGain.connect(this.musicGain);
      const mkOsc = (type = "square") => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        g.gain.value = 0.25;
        o.type = type;
        o.connect(g).connect(this.chordGain);
        o.start();
        return o;
      };
      this.chordOscs = [mkOsc("square"), mkOsc("square"), mkOsc("square")];
      // Optional soft lead for texture
      this.leadOsc = ctx.createOscillator();
      this.leadGain = ctx.createGain();
      this.leadOsc.type = "triangle";
      this.leadGain.gain.value = 0.03;
      this.leadOsc.connect(this.leadGain).connect(this.musicGain);
      this.leadOsc.start();

      // Original punk-ish pattern (not from any song) in A: A5–D5–E5–D5
      const roots = [110.0, 146.83, 164.81, 146.83]; // A2, D3, E3, D3
      const leadNotes = [
        880, 880, 880, 987.77, 880, 783.99, 880, 987.77, // simple arpeggio-ish
      ];
      const beatSec = 60 / this.tempo; // quarter
      const stepSec = beatSec / 2; // eighth notes
      this.currentStep = 0;

      const stepFunc = () => {
        if (!this.ctx) return;
        const t = ctx.currentTime;
        // chord index per quarter note
        const chordIndex = Math.floor(this.currentStep / 2) % roots.length;
        const root = roots[chordIndex];
        const fifth = root * 1.5;
        const octave = root * 2.0;
        const [o1, o2, o3] = this.chordOscs;
        try {
          o1.frequency.setTargetAtTime(root, t, 0.01);
          o2.frequency.setTargetAtTime(fifth, t, 0.01);
          o3.frequency.setTargetAtTime(octave, t, 0.01);
        } catch {}
        // palm-mute envelope
        try {
          this.chordGain.gain.cancelScheduledValues(t);
          this.chordGain.gain.setValueAtTime(0.0, t);
          this.chordGain.gain.linearRampToValueAtTime(0.08, t + 0.01);
          this.chordGain.gain.linearRampToValueAtTime(0.02, t + stepSec * 0.7);
        } catch {}

        // simple drums: hat every 8th, snare on 2/4, kick on 1/3
        const beatPos = this.currentStep % 8; // two bars of 4/4 (eighths)
        this.playHat(t);
        if (beatPos === 2 || beatPos === 6) this.playSnare(t);
        if (beatPos === 0 || beatPos === 4) this.playKick(t);

        // soft lead float
        const lead = leadNotes[this.currentStep % leadNotes.length];
        try {
          this.leadOsc.frequency.setTargetAtTime(lead, t, 0.02);
        } catch {}
        this.currentStep++;
      };

      stepFunc();
      this.musicTimer = setInterval(stepFunc, stepSec * 1000);
    },
    stopMusic() {
      if (!this.ctx) return;
      if (this.musicTimer) {
        clearInterval(this.musicTimer);
        this.musicTimer = null;
      }
      const ctx = this.ctx;
      const stopOsc = (osc) => {
        if (!osc) return;
        try {
          const t = ctx.currentTime;
          osc.stop(t + 0.05);
        } catch {}
      };
      stopOsc(this.leadOsc);
      this.leadOsc = null;
      if (this.chordOscs) {
        this.chordOscs.forEach(stopOsc);
        this.chordOscs = [];
      }
      this.chordGain = null;
    },
    playHit() {
      if (!this.ctx) return;
      this.ensureRunning();
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sawtooth";
      osc.connect(gain).connect(this.sfxGain);
      const t = ctx.currentTime;
      osc.frequency.setValueAtTime(360, t);
      osc.frequency.exponentialRampToValueAtTime(70, t + 0.25);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.6, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.start(t);
      osc.stop(t + 0.32);
    },
    playHat(t) {
      if (!this.ctx || !this.noiseBuffer) return;
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 8000;
      const g = ctx.createGain();
      g.gain.value = 0.10;
      src.connect(hp).connect(g).connect(this.musicGain);
      src.start(t);
      src.stop(t + 0.03);
    },
    playSnare(t) {
      if (!this.ctx || !this.noiseBuffer) return;
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1800;
      bp.Q.value = 0.5;
      const g = ctx.createGain();
      g.gain.value = 0.12;
      src.connect(bp).connect(g).connect(this.musicGain);
      src.start(t);
      src.stop(t + 0.08);
    },
    playKick(t) {
      if (!this.ctx) return;
      const ctx = this.ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.connect(g).connect(this.musicGain);
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(50, t + 0.09);
      g.gain.setValueAtTime(0.2, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      o.start(t);
      o.stop(t + 0.12);
    },
    playWeb() {
      if (!this.ctx) return;
      this.ensureRunning();
      const ctx = this.ctx;
      const t = ctx.currentTime;
      // short filtered noise burst + quick pitch sweep for a "swish/thwip"
      const noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = this.noiseBuffer;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 2500;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 3200;
      const ng = ctx.createGain();
      ng.gain.value = 0.0001;
      noiseSrc.connect(hp).connect(bp).connect(ng).connect(this.sfxGain);
      ng.gain.exponentialRampToValueAtTime(0.3, t + 0.015);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      noiseSrc.start(t);
      noiseSrc.stop(t + 0.13);

      const osc = ctx.createOscillator();
      const og = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(1600, t);
      osc.frequency.exponentialRampToValueAtTime(700, t + 0.08);
      og.gain.setValueAtTime(0.08, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.connect(og).connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + 0.1);
    },
  };

  /** Timing */
  let lastTime = performance.now();

  /** Input */
  function handleAction() {
    if (gameState === State.Menu) {
      startGameWithDifficulty(selectedDifficulty, true);
      return;
    }
    if (gameState === State.GameOver) {
      applyDifficulty(selectedDifficulty);
      resetGame();
      gameState = State.Playing;
      audio.startMusic();
      return;
    }
    if (gameState === State.Playing) {
      impulse();
    }
  }

  function impulse() {
    player.vy = physics.thrust;
    player.webCooldownMs = 120;
    const attachY = Math.max(40, player.y - 120);
    const attachX = player.x + (Math.random() * 60 - 30);
    webLine = {
      x1: player.x,
      y1: player.y,
      x2: attachX,
      y2: attachY,
      life: 180, // ms
    };
    audio.playWeb && audio.playWeb();
  }

  /** Obstacles */
  function clearObstacles() {
    obstacles.list.length = 0;
    obstacles.lastSpawnX = 0;
  }

  function spawnIfNeeded() {
    const farthestX = obstacles.list.length
      ? obstacles.list[obstacles.list.length - 1].x
      : VIEW_WIDTH;
    if (
      obstacles.list.length === 0 ||
      farthestX < VIEW_WIDTH - obstacles.spacing
    ) {
      const gap = randRange(obstacles.minGap, obstacles.maxGap);
      const gapY = randRange(80, VIEW_HEIGHT - physics.floorHeight - 80 - gap);
      obstacles.list.push({
        x: VIEW_WIDTH + obstacles.width,
        y: 0,
        width: obstacles.width,
        gapY,
        gapHeight: gap,
        passed: false,
        colorIndex: Math.floor(Math.random() * 3),
      });
    }
  }

  function updateObstacles(dt) {
    const speed = obstacles.speed;
    for (let i = obstacles.list.length - 1; i >= 0; i--) {
      const o = obstacles.list[i];
      o.x -= speed;
      if (o.x + o.width < -10) {
        obstacles.list.splice(i, 1);
      }
    }
    spawnIfNeeded();
  }

  /** Reset */
  function resetGame() {
    player.x = VIEW_WIDTH * 0.28;
    player.y = VIEW_HEIGHT * 0.45;
    player.vy = 0;
    player.alive = true;
    score = 0;
    clearObstacles();
    webLine = null;
  }

  function applyDifficulty(presetName) {
    const p = DifficultyPresets[presetName] || DifficultyPresets[Difficulty.Medium];
    obstacles.speed = p.speed;
    obstacles.spacing = p.spacing;
    obstacles.minGap = p.minGap;
    obstacles.maxGap = p.maxGap;
    collisionPadding = p.collisionPadding;
  }

  function startGameWithDifficulty(presetName, doImpulse = true) {
    selectedDifficulty = presetName;
    applyDifficulty(selectedDifficulty);
    resetGame();
    currentPhase = 0;
    theme = generateTheme(currentPhase);
    gameState = State.Playing;
    audio.init();
    audio.startMusic();
    if (doImpulse) impulse();
  }

  /** Main loop */
  function tick(now) {
    const dtMs = Math.min(32, now - lastTime);
    lastTime = now;

    update(dtMs);
    render();
    requestAnimationFrame(tick);
  }

  function update(dtMs) {
    if (gameState === State.Playing) {
      // Physics
      player.vy = clamp(
        player.vy + physics.gravity,
        -Infinity,
        physics.terminalVel
      );
      player.y += player.vy;
      if (player.webCooldownMs > 0) player.webCooldownMs -= dtMs;
      if (webLine) {
        webLine.life -= dtMs;
        if (webLine.life <= 0) webLine = null;
      }

      // Collisions with bounds
      const ceiling = 0 + 0;
      const floorY = VIEW_HEIGHT - physics.floorHeight;
      if (player.y - player.radius < ceiling || player.y + player.radius > floorY) {
        return doGameOver();
      }

      // Obstacles
      updateObstacles(dtMs);

      // Scoring + collision per obstacle
      for (const o of obstacles.list) {
        if (!o.passed && o.x + o.width < player.x - player.radius) {
          o.passed = true;
          score += 1;
          // ramp base difficulty a bit
          if (score % 5 === 0) {
            obstacles.speed += 0.12;
            obstacles.spacing = Math.max(180, obstacles.spacing - 2);
            obstacles.minGap = Math.max(120, obstacles.minGap - 1);
          }
          // phase change each 30 points (30, 60, 90, ...)
          if (score > 0 && score % 30 === 0) {
            currentPhase += 1;
            theme = generateTheme(currentPhase);
            // change music flavor each phase
            audio.stopMusic();
            audio.startMusic();
          }
        }

        // Top building rect (with difficulty padding)
        const topRectRaw = { x: o.x, y: 0, w: o.width, h: o.gapY };
        // Bottom building rect (with difficulty padding)
        const bottomRectRaw = {
          x: o.x,
          y: o.gapY + o.gapHeight,
          w: o.width,
          h: VIEW_HEIGHT - physics.floorHeight - (o.gapY + o.gapHeight),
        };
        const topRect = shrinkRect(
          topRectRaw.x,
          topRectRaw.y,
          topRectRaw.w,
          topRectRaw.h,
          collisionPadding
        );
        const bottomRect = shrinkRect(
          bottomRectRaw.x,
          bottomRectRaw.y,
          bottomRectRaw.w,
          bottomRectRaw.h,
          collisionPadding
        );
        if (
          circleRectCollision(
            player.x,
            player.y,
            player.radius,
            topRect.x,
            topRect.y,
            topRect.w,
            topRect.h
          ) ||
          circleRectCollision(
            player.x,
            player.y,
            player.radius,
            bottomRect.x,
            bottomRect.y,
            bottomRect.w,
            bottomRect.h
          )
        ) {
          return doGameOver();
        }
      }
    }
  }

  function doGameOver() {
    if (gameState !== State.Playing) return;
    gameState = State.GameOver;
    best = Math.max(best, score);
    localStorage.setItem("flipspider.best", String(best));
    audio.playHit();
    audio.stopMusic();
  }

  /** Rendering */
  function render() {
    // Sky background (theme-based)
    const sky = theme || defaultTheme();
    const g = ctx.createLinearGradient(0, 0, 0, VIEW_HEIGHT);
    g.addColorStop(0, sky.bgTop);
    g.addColorStop(0.5, sky.bgMid);
    g.addColorStop(1, sky.bgBot);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

    // Stars
    drawStars();

    // Parallax far skyline (static)
    drawSkyline(0.4, 60, sky.skylineFar);
    // Near skyline
    drawSkyline(0.8, 120, sky.skylineNear);

    // Obstacles (buildings with a gap)
    for (const o of obstacles.list) {
      drawBuildingPair(o);
    }

    // Ground
    drawGround(sky);

    // Web effect
    if (webLine) drawWebLine(webLine);

    // Player
    drawSpider(player.x, player.y, player.radius);

    // HUD
    drawHUD();
  }

  function drawStars() {
    ctx.save();
    const sky = theme || defaultTheme();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = sky.starColor;
    for (let i = 0; i < 40; i++) {
      const x = (i * 127) % VIEW_WIDTH; // static stars, no time-based drift
      const y = (i * 61) % (VIEW_HEIGHT - 200);
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.restore();
  }

  function drawSkyline(parallax, height, color) {
    ctx.save();
    ctx.fillStyle = color;
    const baseY = VIEW_HEIGHT - physics.floorHeight - height;
    const offset = 0; // static skyline, no parallax scroll
    for (let x = -80 - offset; x < VIEW_WIDTH + 80; x += 80) {
      const w = 50 + ((x * 31) % 30);
      const h = 40 + ((x * 17) % (height - 10));
      ctx.fillRect(x, baseY + (height - h), w, h);
    }
    ctx.restore();
  }

  function drawBuildingPair(o) {
    const sky = theme || defaultTheme();
    const colors = sky.buildingPalette;
    const color = colors[o.colorIndex % colors.length];
    ctx.fillStyle = color;
    // top
    ctx.fillRect(o.x, 0, o.width, o.gapY);
    // bottom
    ctx.fillRect(
      o.x,
      o.gapY + o.gapHeight,
      o.width,
      VIEW_HEIGHT - physics.floorHeight - (o.gapY + o.gapHeight)
    );
    // windows hint
    ctx.fillStyle = sky.windowTint;
    const winSize = 6;
    for (let yy = 8; yy < o.gapY - 8; yy += 12) {
      for (let xx = 4; xx < o.width - 6; xx += 10) {
        ctx.fillRect(o.x + xx, yy, winSize, winSize);
      }
    }
    const bottomTop = o.gapY + o.gapHeight;
    const bottomH = VIEW_HEIGHT - physics.floorHeight - bottomTop;
    for (let yy = bottomTop + 8; yy < bottomTop + bottomH - 8; yy += 12) {
      for (let xx = 4; xx < o.width - 6; xx += 10) {
        ctx.fillRect(o.x + xx, yy, winSize, winSize);
      }
    }
  }

  function drawGround(sky) {
    const y = VIEW_HEIGHT - physics.floorHeight;
    const g = ctx.createLinearGradient(0, y, 0, VIEW_HEIGHT);
    g.addColorStop(0, sky.groundTop);
    g.addColorStop(1, sky.groundBot);
    ctx.fillStyle = g;
    ctx.fillRect(0, y, VIEW_WIDTH, physics.floorHeight);
    // dashed street lines
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 2;
    ctx.setLineDash([12, 16]);
    ctx.beginPath();
    ctx.moveTo(0, y + physics.floorHeight * 0.5);
    ctx.lineTo(VIEW_WIDTH, y + physics.floorHeight * 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawWebLine(l) {
    ctx.save();
    const lifeRatio = Math.max(0, Math.min(1, l.life / 180));
    ctx.globalAlpha = lifeRatio;
    ctx.strokeStyle = (theme || defaultTheme()).hudPrimary;
    ctx.lineWidth = 2;

    // Curved main strand (quadratic curve) from player to anchor
    const ctrlX = (l.x1 + l.x2) / 2 + (l.x2 - l.x1) * 0.05;
    const ctrlY = Math.min(l.y1, l.y2) - 30; // slight arc upward
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.quadraticCurveTo(ctrlX, ctrlY, l.x2, l.y2);
    ctx.stroke();

    // Concentric rings near the anchor
    ctx.globalAlpha = lifeRatio * 0.7;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      const r = 3 + i * 3 * (1 + (1 - lifeRatio));
      ctx.arc(l.x2, l.y2, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Cross strands along the curve
    ctx.globalAlpha = lifeRatio * 0.6;
    const steps = 5;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = (1 - t) * (1 - t) * l.x1 + 2 * (1 - t) * t * ctrlX + t * t * l.x2;
      const y = (1 - t) * (1 - t) * l.y1 + 2 * (1 - t) * t * ctrlY + t * t * l.y2;
      const nx = ctrlY - (l.y2 - l.y1); // rough normal hint
      const ny = (l.x2 - l.x1) - ctrlX;
      const k = 0.06;
      ctx.beginPath();
      ctx.moveTo(x - (l.y2 - l.y1) * k, y + (l.x2 - l.x1) * k);
      ctx.lineTo(x + (l.y2 - l.y1) * k, y - (l.x2 - l.x1) * k);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawSpider(x, y, r) {
    ctx.save();
    ctx.translate(x, y);

    // Funko-style proportions
    const headWidth = r * 1.9;
    const headHeight = r * 1.6;
    const headX = -headWidth / 2;
    const headY = -r * 1.55; // head sits above center
    const headRadius = Math.min(headWidth, headHeight) * 0.28;

    // Head base (red gradient)
    const headGrad = ctx.createLinearGradient(0, headY, 0, headY + headHeight);
    headGrad.addColorStop(0, "#ff5b60");
    headGrad.addColorStop(1, "#bf1e2e");
    ctx.fillStyle = headGrad;
    roundRect(ctx, headX, headY, headWidth, headHeight, headRadius);
    ctx.fill();

    // Web pattern on the head (clipped)
    ctx.save();
    roundRect(ctx, headX, headY, headWidth, headHeight, headRadius);
    ctx.clip();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1.2;
    // radials from approximate center
    const cx = 0;
    const cy = headY + headHeight * 0.45;
    for (let a = -Math.PI * 0.1; a < Math.PI * 1.1; a += Math.PI / 6) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(
        cx + Math.cos(a) * (headWidth * 0.7),
        cy + Math.sin(a) * (headHeight * 0.7)
      );
      ctx.stroke();
    }
    // concentric arcs
    for (let rr = headHeight * 0.25; rr <= headHeight * 0.75; rr += headHeight * 0.17) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, rr * 0.95, rr, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // Eyes (big white eyes with dark outline)
    const eyeStroke = "#0b0b0b";
    ctx.lineWidth = 2.2;
    // Left eye
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.ellipse(
      -headWidth * 0.26,
      headY + headHeight * 0.45,
      headWidth * 0.24,
      headHeight * 0.2,
      -0.35,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.strokeStyle = eyeStroke;
    ctx.stroke();
    // Right eye
    ctx.beginPath();
    ctx.ellipse(
      headWidth * 0.26,
      headY + headHeight * 0.45,
      headWidth * 0.24,
      headHeight * 0.2,
      0.35,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.stroke();

    // Tiny body (blue suit with red upper chest)
    const bodyWidth = r * 1.1;
    const bodyHeight = r * 1.15;
    const bodyX = -bodyWidth / 2;
    const bodyY = -r * 0.25;
    const bodyRadius = Math.min(bodyWidth, bodyHeight) * 0.2;
    // base blue
    ctx.fillStyle = "#1b3f8a";
    roundRect(ctx, bodyX, bodyY, bodyWidth, bodyHeight, bodyRadius);
    ctx.fill();
    // upper chest red panel
    ctx.fillStyle = "#c7232f";
    roundRect(
      ctx,
      bodyX + 4,
      bodyY + 4,
      bodyWidth - 8,
      bodyHeight * 0.42,
      bodyRadius * 0.8
    );
    ctx.fill();

    // Spider emblem (simple)
    ctx.save();
    ctx.fillStyle = "#0b0b0b";
    ctx.translate(0, bodyY + bodyHeight * 0.28);
    ctx.beginPath();
    ctx.ellipse(0, 0, 6, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    // legs
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "#0b0b0b";
    for (let i = -1; i <= 1; i += 2) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(6 * i, -4);
      ctx.moveTo(0, 1.5);
      ctx.lineTo(6 * i, 0.5);
      ctx.moveTo(0, 3);
      ctx.lineTo(6 * i, 3.5);
      ctx.stroke();
    }
    ctx.restore();

    // Arms
    ctx.fillStyle = "#1b3f8a";
    const armW = r * 0.35;
    const armH = r * 0.28;
    roundRect(ctx, bodyX - armW * 0.8, bodyY + 12, armW, armH, 8);
    ctx.fill();
    roundRect(ctx, -bodyX - armW * 0.2, bodyY + 12, armW, armH, 8);
    ctx.fill();
    // red gloves
    ctx.fillStyle = "#c7232f";
    roundRect(ctx, bodyX - armW * 0.8, bodyY + 12 + armH - 8, armW, 10, 6);
    ctx.fill();
    roundRect(ctx, -bodyX - armW * 0.2, bodyY + 12 + armH - 8, armW, 10, 6);
    ctx.fill();

    // Legs
    ctx.fillStyle = "#1b3f8a";
    const legW = r * 0.32;
    const legH = r * 0.45;
    const legsY = bodyY + bodyHeight - 6;
    roundRect(ctx, -legW - 6, legsY, legW, legH, 8);
    ctx.fill();
    roundRect(ctx, 6, legsY, legW, legH, 8);
    ctx.fill();
    // red boots
    ctx.fillStyle = "#c7232f";
    roundRect(ctx, -legW - 6, legsY + legH - 10, legW, 12, 6);
    ctx.fill();
    roundRect(ctx, 6, legsY + legH - 10, legW, 12, 6);
    ctx.fill();

    ctx.restore();
  }

  function drawHUD() {
    ctx.save();
    ctx.fillStyle = (theme || defaultTheme()).hudPrimary;
    ctx.textAlign = "center";
    // Large score during play
    if (gameState === State.Playing) {
      ctx.font = "700 48px system-ui, -apple-system, Segoe UI, Roboto";
      ctx.fillText(String(score), VIEW_WIDTH / 2, 90);
    }

    // Overlay prompts
    if (gameState === State.Menu) {
      drawTitle();
      drawDifficultyMenu();
    } else if (gameState === State.GameOver) {
      // Title
      ctx.font = "800 42px system-ui, -apple-system, Segoe UI, Roboto";
      ctx.fillText("Game Over", VIEW_WIDTH / 2, VIEW_HEIGHT * 0.32);
      // Big score highlight
      ctx.font = "900 66px system-ui, -apple-system, Segoe UI, Roboto";
      ctx.fillText(`Score ${score}`, VIEW_WIDTH / 2, VIEW_HEIGHT * 0.42);
      // Best and share prompt
      ctx.font = "600 22px system-ui, -apple-system, Segoe UI, Roboto";
      ctx.fillText(`Best ${best}`, VIEW_WIDTH / 2, VIEW_HEIGHT * 0.48);
      ctx.font = "600 18px system-ui, -apple-system, Segoe UI, Roboto";
      ctx.fillText("Share this to challenge your friends!", VIEW_WIDTH / 2, VIEW_HEIGHT * 0.53);

      // Buttons: Play Again, Back to Menu, Share (screenshot)
      const w = 340;
      const h = 54;
      const x = (VIEW_WIDTH - w) / 2;
      const playY = VIEW_HEIGHT * 0.62;
      const menuY = playY + h + 12;
      const shareY = menuY + h + 12;
      drawCenteredButton("Play Again", playY);
      drawCenteredButton("Back to Menu", menuY);
      drawCenteredButton("Share Screenshot", shareY);
      // Register hitboxes for clicks
      gameOverHitboxes = [
        { type: "play", x, y: playY - h / 2, w, h },
        { type: "menu", x, y: menuY - h / 2, w, h },
        { type: "share", x, y: shareY - h / 2, w, h },
      ];
    }
    ctx.restore();
  }

  function drawTitle() {
    ctx.save();
    ctx.textAlign = "center";
    const titleY = VIEW_HEIGHT * 0.3;
    ctx.font = "900 54px system-ui, -apple-system, Segoe UI, Roboto";
    ctx.fillStyle = (theme || defaultTheme()).hudPrimary;
    ctx.fillText("Flip Spider", VIEW_WIDTH / 2, titleY);
    ctx.font = "500 18px system-ui, -apple-system, Segoe UI, Roboto";
    ctx.fillStyle = (theme || defaultTheme()).hudSecondary;
    ctx.fillText("Throw webs to vault between buildings.", VIEW_WIDTH / 2, titleY + 28);
    ctx.fillText("Pass Gaps to Score!", VIEW_WIDTH / 2, titleY + 50);
    ctx.restore();
  }

  // Difficulty menu UI
  let menuHitboxes = [];
  let gameOverHitboxes = [];
  function drawDifficultyMenu() {
    const labels = [Difficulty.Easy, Difficulty.Medium, Difficulty.Hard];
    const w = 320;
    const h = 52;
    const gap = 16;
    const startY = VIEW_HEIGHT * 0.45;
    const x = (VIEW_WIDTH - w) / 2;
    menuHitboxes = [];
    for (let i = 0; i < labels.length; i++) {
      const y = startY + i * (h + gap);
      const isSelected = labels[i] === selectedDifficulty;
      drawMenuButton(x, y, w, h, labels[i], isSelected);
      menuHitboxes.push({ label: labels[i], x, y, w, h });
    }
    // hint text
    ctx.fillStyle = "#c7d2fe";
    ctx.font = "600 16px system-ui, -apple-system, Segoe UI, Roboto";
    ctx.textAlign = "center";
    ctx.fillText(
      "Click a difficulty or press 1/2/3. Press Space to start.",
      VIEW_WIDTH / 2,
      startY + labels.length * (h + gap) + 6
    );
  }

  function drawMenuButton(x, y, w, h, label, selected) {
    ctx.save();
    const r = 12;
    const base1 = selected ? "#ff6b73" : "#34406a";
    const base2 = selected ? "#c92434" : "#263258";
    const gr = ctx.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, base1);
    gr.addColorStop(1, base2);
    ctx.fillStyle = gr;
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    // label
    ctx.fillStyle = (theme || defaultTheme()).hudPrimary;
    ctx.font = "700 18px system-ui, -apple-system, Segoe UI, Roboto";
    ctx.textAlign = "center";
    ctx.fillText(label, x + w / 2, y + h / 2 + 6);
    ctx.restore();
  }

  function drawCenteredButton(label, y) {
    const w = 340;
    const h = 54;
    const x = (VIEW_WIDTH - w) / 2;
    const r = 12;
    ctx.save();
    // button base
    const gr = ctx.createLinearGradient(0, y - h, 0, y + h);
    gr.addColorStop(0, "#ff6672");
    gr.addColorStop(1, "#bf1e2e");
    ctx.fillStyle = gr;
    roundRect(ctx, x, y - h / 2, w, h, r);
    ctx.fill();
    // label
    ctx.fillStyle = (theme || defaultTheme()).hudPrimary;
    ctx.font = "700 18px system-ui, -apple-system, Segoe UI, Roboto";
    ctx.textAlign = "center";
    ctx.fillText(label, VIEW_WIDTH / 2, y + 6);
    ctx.restore();
  }

  /** Utilities */
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function defaultTheme() {
    return {
      bgTop: "#0b1225",
      bgMid: "#162a63",
      bgBot: "#2b2c6b",
      skylineFar: "#0a1736",
      skylineNear: "#0e1d45",
      groundTop: "#0f1a3a",
      groundBot: "#0a1228",
      buildingPalette: ["#182a5b", "#1c326d", "#203a7f"],
      windowTint: "rgba(255, 255, 255, 0.06)",
      starColor: "#ffffff",
      hudPrimary: "#ffffff",
      hudSecondary: "#c7d2fe",
    };
  }

  function generateTheme(seedIndex) {
    // Random but deterministic-ish per phase using seedIndex
    const rand = seededRandom(seedIndex * 9301 + 49297);
    const hueBase = Math.floor(rand() * 360);
    const hue2 = (hueBase + 30 + Math.floor(rand() * 60)) % 360;
    const hue3 = (hueBase + 180 + Math.floor(rand() * 60)) % 360;
    const bgTop = `hsl(${hueBase}, 60%, 16%)`;
    const bgMid = `hsl(${hue2}, 60%, 22%)`;
    const bgBot = `hsl(${hue3}, 55%, 24%)`;
    const skylineFar = `hsl(${(hueBase + 200) % 360}, 45%, 18%)`;
    const skylineNear = `hsl(${(hueBase + 210) % 360}, 50%, 22%)`;
    const groundTop = `hsl(${(hueBase + 230) % 360}, 35%, 16%)`;
    const groundBot = `hsl(${(hueBase + 250) % 360}, 35%, 12%)`;
    const buildingPalette = [
      `hsl(${(hueBase + 10) % 360}, 50%, 34%)`,
      `hsl(${(hueBase + 25) % 360}, 50%, 30%)`,
      `hsl(${(hueBase + 40) % 360}, 50%, 26%)`,
    ];
    const windowTint = `hsla(${(hueBase + 60) % 360}, 70%, 85%, 0.10)`;
    const starColor = `hsl(${(hueBase + 90) % 360}, 80%, 95%)`;
    const hudPrimary = `hsl(${(hueBase + 320) % 360}, 90%, 98%)`;
    const hudSecondary = `hsl(${(hueBase + 320) % 360}, 60%, 80%)`;
    // Also influence music tempo slightly per phase
    audio.tempo = 150 + Math.floor(rand() * 60); // 150–210
    return {
      bgTop,
      bgMid,
      bgBot,
      skylineFar,
      skylineNear,
      groundTop,
      groundBot,
      buildingPalette,
      windowTint,
      starColor,
      hudPrimary,
      hudSecondary,
    };
  }

  function seededRandom(seed) {
    let s = seed >>> 0;
    return function () {
      // xorshift32
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      // convert to [0,1)
      return ((s >>> 0) / 4294967296);
    };
  }

  function shrinkRect(rx, ry, rw, rh, pad) {
    const p = Math.max(-20, Math.min(20, pad || 0));
    return { x: rx + p, y: ry + p, w: Math.max(0, rw - p * 2), h: Math.max(0, rh - p * 2) };
  }

  function randRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function circleRectCollision(cx, cy, radius, rx, ry, rw, rh) {
    const closestX = clamp(cx, rx, rx + rw);
    const closestY = clamp(cy, ry, ry + rh);
    const dx = cx - closestX;
    const dy = cy - closestY;
    return dx * dx + dy * dy < radius * radius;
  }

  /** Input events */
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      if (gameState === State.Menu) {
        startGameWithDifficulty(selectedDifficulty, true);
      } else {
        handleAction();
      }
    }
    if (gameState === State.Menu) {
      if (e.key === "1") selectedDifficulty = Difficulty.Easy;
      if (e.key === "2") selectedDifficulty = Difficulty.Medium;
      if (e.key === "3") selectedDifficulty = Difficulty.Hard;
    }
    if (e.key === "r" && gameState === State.GameOver) {
      handleAction();
    }
  });
  window.addEventListener(
    "mousedown",
    (e) => {
      e.preventDefault();
      audio.init(); // allow audio context to start on first user gesture
      requestFullscreenIfPossible();
      const p = getCanvasPointFromClient(e.clientX, e.clientY);
      if (gameState === State.Menu) {
        if (tryHandleMenuClick(p.x, p.y)) return;
        startGameWithDifficulty(selectedDifficulty, true);
        return;
      } else if (gameState === State.GameOver) {
        if (tryHandleGameOverClick(p.x, p.y)) return;
        // Fallback: click anywhere to play again
        applyDifficulty(selectedDifficulty);
        resetGame();
        gameState = State.Playing;
        audio.startMusic();
        return;
      }
      handleAction();
    },
    false
  );
  window.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      audio.init();
      requestFullscreenIfPossible();
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return handleAction();
      const p = getCanvasPointFromClient(t.clientX, t.clientY);
      if (gameState === State.Menu) {
        if (tryHandleMenuClick(p.x, p.y)) return;
        startGameWithDifficulty(selectedDifficulty, true);
        return;
      } else if (gameState === State.GameOver) {
        if (tryHandleGameOverClick(p.x, p.y)) return;
        applyDifficulty(selectedDifficulty);
        resetGame();
        gameState = State.Playing;
        audio.startMusic();
        return;
      }
      handleAction();
    },
    { passive: false }
  );

  function getCanvasPointFromClient(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
  }

  function requestFullscreenIfPossible() {
    const el = document.documentElement; // go fullscreen for the whole page
    const canFS = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (!canFS) return;
    const isFS = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
    if (!isFS) {
      try {
        canFS.call(el);
      } catch {}
    }
  }

  function tryHandleMenuClick(px, py) {
    for (const b of menuHitboxes) {
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
        startGameWithDifficulty(b.label, true);
        return true;
      }
    }
    return false;
  }

  function tryHandleGameOverClick(px, py) {
    for (const b of gameOverHitboxes) {
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
        if (b.type === "play") {
          applyDifficulty(selectedDifficulty);
          resetGame();
          gameState = State.Playing;
          audio.startMusic();
        } else if (b.type === "menu") {
          gameState = State.Menu;
        } else if (b.type === "share") {
          shareScore();
        }
        return true;
      }
    }
    return false;
  }

  async function shareScore() {
    try {
      const blob = await canvasToBlob(canvas);
      const files = [new File([blob], "flipspider-score.png", { type: blob.type })];
      const shareData = {
        title: "Flip Spider",
        text: `I scored ${score} in Flip Spider! Can you beat me?`,
        url: window.location.href,
        files,
      };
      if (navigator.canShare && navigator.canShare({ files })) {
        await navigator.share(shareData);
        return;
      }
    } catch {}
    // Fallback to opening a Twitter share with no image if File sharing is unsupported
    const shareText = `I scored ${score} in Flip Spider! Can you beat me?`;
    const twitter = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(window.location.href)}`;
    window.open(twitter, "_blank");
  }

  function canvasToBlob(c) {
    return new Promise((resolve) => {
      if (c.toBlob) {
        c.toBlob((blob) => resolve(blob || new Blob()), "image/png", 0.95);
      } else {
        const dataUrl = c.toDataURL("image/png");
        const bin = atob(dataUrl.split(",")[1] || "");
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        resolve(new Blob([arr], { type: "image/png" }));
      }
    });
  }

  // Start loop
  requestAnimationFrame((t) => {
    lastTime = t;
    requestAnimationFrame(tick);
  });
})();


