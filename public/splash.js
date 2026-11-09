// Abertura do app (primeira vez): tubos de tinta chegam de lugares diferentes, como rotas alternativas, e cada
// um escorrega até virar um traço da logo. A câmera começa rente ao papel, desfocada, e sobe num plano só até a
// vista de cima; os tubos se achatam e fica a logo em 2D. Depois um tubo sai da logo pela direita, a câmera vai
// junto até a tela ao lado e os tubos escrevem "Olá, bem-vindo" do mesmo jeito. Só as cores da logo: tinta (--ink)
// sobre o fundo (--bg).
// Sem dependências. RotazSplash(canvas, { colors }) devolve render(t): mesmo t, mesma imagem.
// colors() é lida a cada quadro, então a troca de tema do sistema vale no meio da animação.
  const E = {
    'sine.inOut': (p) => -(Math.cos(Math.PI * p) - 1) / 2,
    'power2.inOut': (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    'power2.out': (p) => 1 - Math.pow(1 - p, 3),
  };
  const seg = (t, a, d, e) => E[e](Math.min(1, Math.max(0, (t - a) / d)));
  const mix = (a, b, p) => a + (b - a) * p;

  const K = 1.05696, PEN = 18.445, PEN_B = 17.662;
  const CLIP = 'M-1886.73 -1576.47L2594.67 2198.15L4589.48 78.2L108.07 -3696.42Z';
  // Cada tubo: traço (do logo.svg), de onde vem a rota (direção no papel) e se o traço é recortado.
  const TUBES = [
    { d: 'M294.42 487.31L294.39 341.76C294.61 319.46 322.8 308.08 342.03 322.86L551.1 502.64', from: [0.55, 0.85] },
    { d: 'M257.06 224.07L444.56 224.21C480.82 224.5 521.24 255.7 523.25 294.2C516.58 366.97 437.58 364.61 411.66 362.04', from: [0.2, -1], clip: true },
    { d: 'M854.69 397.55C854.75 409.74 851.93 421.93 846.71 433.01C841.49 444.09 833.93 454.09 824.8 462.43C815.67 470.78 804.92 477.5 793.22 482.06C781.51 486.62 768.87 488.98 756.22 488.99C743.56 489.01 730.92 486.72 719.09 482.34C707.26 477.96 696.22 471.48 686.88 463.15C677.53 454.82 669.91 444.62 664.86 433.35C659.81 422.07 657.34 409.76 657.59 397.55C657.84 385.33 660.77 373.24 665.95 362.17C671.12 351.1 678.53 341.04 687.6 332.62C696.66 324.21 707.41 317.43 719.12 312.82C730.83 308.2 743.51 305.75 756.22 305.72C768.92 305.69 781.63 308.08 793.36 312.7C805.09 317.32 815.82 324.14 824.88 332.58C833.94 341.01 841.37 351.06 846.56 362.14C851.75 373.22 854.64 385.35 854.69 397.55', from: [0.35, 1] },
    { d: 'M959.05 308.79L1127.7 308.68', from: [-0.4, -1] },
    { d: 'M1042.56 308.73L1042.6 487.24', from: [0.15, -1] },
    { d: 'M1197.99 487.69L1308.67 307.41L1418.78 487.69', from: [0.1, 1] },
    { d: 'M1514.78 307.47L1695.64 307.47L1514.18 484.55L1695.67 485.2', from: [0.1, -1] },
  ];
  const FINAL = [
    ['M294.42 487.31L294.39 341.76C294.61 319.46 322.8 308.08 342.03 322.86L551.1 502.64', PEN],
    ['M257.06 224.07L444.56 224.21C480.82 224.5 521.24 255.7 523.25 294.2', PEN_B],
    ['M523.25 294.2C516.58 366.97 437.58 364.61 411.66 362.04', PEN_B, true],
    [TUBES[2].d, PEN], ['M959.05 308.79L1127.7 308.68', PEN], ['M1042.56 308.73L1042.6 487.24', PEN],
    ['M1197.99 487.69L1308.67 307.41', PEN], ['M1308.67 307.72L1418.78 487.69', PEN],
    ['M1514.78 307.47L1695.64 307.47', PEN], ['M1693.72 307.11L1514.18 484.55', PEN], ['M1514.8 485.05L1695.67 485.2', PEN],
  ];

  // Saudação: glifos de traço único no mesmo desenho geométrico da logo (maiúscula 180, minúscula 120, base em 0).
  // Cada traço vira um tubo, na ordem em que se escreve. As letras cobrem as saudações em português, inglês,
  // espanhol, alemão e francês; em outra escrita (chinês, japonês, coreano), um tubo sublinha o texto e ele aparece.
  const GREETING = 'Olá, bem-vindo';
  const GLYPHS = {
    O: [180, ['M90 -180A90 90 0 1 1 90 0A90 90 0 1 1 90 -180']],
    l: [0, ['M0 -180L0 0']],
    'á': [120, ['M120 -60A60 60 0 1 0 0 -60A60 60 0 1 0 120 -60', 'M120 -120L120 0', 'M50 -150L80 -184']],
    ',': [10, ['M8 -8L-2 22']],
    b: [120, ['M0 -180L0 0', 'M0 -60A60 60 0 1 1 120 -60A60 60 0 1 1 0 -60']],
    e: [120, ['M0 -60L120 -60A60 60 0 1 0 105.96 -21.43']],
    m: [180, ['M0 0L0 -75A45 45 0 0 1 90 -75L90 0', 'M90 -75A45 45 0 0 1 180 -75L180 0']],
    '-': [50, ['M0 -60L50 -60']],
    v: [110, ['M0 -120L55 0L110 -120']],
    i: [0, ['M0 -120L0 0', 'M0 -162L0 -158']],
    n: [100, ['M0 0L0 -70A50 50 0 0 1 100 -70L100 0']],
    d: [120, ['M120 -60A60 60 0 1 0 0 -60A60 60 0 1 0 120 -60', 'M120 -180L120 0']],
    o: [120, ['M60 -120A60 60 0 1 0 60 0A60 60 0 1 0 60 -120']],
    H: [140, ['M0 -180L0 0', 'M140 -180L140 0', 'M0 -90L140 -90']],
    B: [115, ['M0 0L0 -180L62 -180A45 45 0 0 1 62 -90L0 -90', 'M0 -90L70 -90A45 45 0 0 1 70 0L0 0']],
    a: [120, ['M120 -60A60 60 0 1 0 0 -60A60 60 0 1 0 120 -60', 'M120 -120L120 0']],
    c: [104, ['M102.43 -102.43A60 60 0 1 0 102.43 -17.57']],
    w: [170, ['M0 -120L42 0L85 -120L128 0L170 -120']],
    k: [95, ['M0 -180L0 0', 'M95 -120L0 -42', 'M36 -72L95 0']],
    j: [30, ['M30 -120L30 12A30 30 0 0 1 0 42', 'M30 -162L30 -158']],
    u: [100, ['M0 -120L0 -50A50 50 0 0 0 100 -50L100 -120', 'M100 -120L100 0']],
    r: [75, ['M0 0L0 -120', 'M0 -64A56 56 0 0 1 75 -116']],
  };
  const GAP = 46, SPACE = 92;
  // De onde vem cada tubo da saudação (direção no papel), em rodízio.
  const GREET_FROM = [[0.3, -1], [-0.25, 1], [0.6, 1], [-0.5, -1], [0.15, 1], [0.7, -1], [-0.1, -1], [0.4, 1]];

  // Tempos (s). Logo: cada tubo parte GAP depois do anterior e leva TRAVEL para chegar e assentar.
  // Depois: um tubo sai do Z pela direita (exit), a câmera vai junto (pan) e a saudação se escreve (greet).
  const T = {
    first: 0, gap: 0.42, travel: 2.9, lag: 0.45, rise: [0.8, 5.4], yaw: [1.2, 4.9], dofOff: [4.6, 1.4], flat: [5.6, 1.0], swap: [6.3, 0.6], settle: [6.2, 1.6],
    exit: [7.2, 2.4, 0.55], pan: [7.3, 2.8], greet: [8.45, 0.075, 1.5, 0.32], flat2: [11.0, 0.9], breathe: [9.6, 3.0], duration: 12.4,
  };

  function RotazSplash(canvas, opts = {}) {
    const colors = opts.colors || (() => ({ ground: '#f3f1ec', ink: '#1f1d1a', dark: false }));
    const greeting = opts.greeting || GREETING;
    // a saudação vira tubos quando todas as letras existem; senão, o texto aparece sobre um sublinhado em tubo
    const drawn = [...greeting].every((ch) => ch === ' ' || GLYPHS[ch]);
    let label = null;
    const ctx = canvas.getContext('2d');
    const W = 1920, H = 1080, LW = 860, s = LW / 1457, ox = (W - LW) / 2, oy = (H - 315 * s) / 2;
    const toStage = (x, y) => [ox + (x - 248) * s, oy + (y * K - 227) * s];
    const clipPath = new Path2D(CLIP), probe = document.createElement('canvas').getContext('2d');
    const NS = 'http://www.w3.org/2000/svg';
    const norm2 = (v) => { const n = Math.hypot(v[0], v[1]) || 1; return [v[0] / n, v[1] / n]; };

    // Cada tubo: rota de chegada (curva no papel, de fora até o começo do traço, tangente a ele) + o traço.
    const makeTube = ({ d, map, clip, from, fromPoint, reach = 1500, start, travel, lag, head0 = 0, tail0 = 0, group }) => {
      const el = document.createElementNS(NS, 'path'); el.setAttribute('d', d);
      const len = el.getTotalLength(), stroke = [];
      for (let L = 0; L <= len; L += 3) { const p = el.getPointAtLength(L); if (clip && !probe.isPointInPath(clipPath, p.x, p.y)) break; stroke.push(map(p.x, p.y)); }
      // fecha no ponto final exato (no O, o fim encontra o começo sem degrau)
      if (!clip && len % 3) { const p = el.getPointAtLength(len); stroke.push(map(p.x, p.y)); }
      const P0 = stroke[0], P1 = stroke[Math.min(4, stroke.length - 1)], dir = norm2([P1[0] - P0[0], P1[1] - P0[1]]);
      let O, B1;
      if (fromPoint) { O = fromPoint; B1 = [O[0] + 620, O[1]]; }
      else { const A = norm2(from); O = [P0[0] + A[0] * reach, P0[1] + A[1] * reach]; B1 = [O[0] - A[0] * reach * 0.43, O[1] - A[1] * reach * 0.43]; }
      const B2 = [P0[0] - dir[0] * 320, P0[1] - dir[1] * 320];
      const pts = [];
      for (let k = 0; k < 160; k++) { const u = k / 160, m = 1 - u; pts.push([0, 1].map((c) => m * m * m * O[c] + 3 * m * m * u * B1[c] + 3 * m * u * u * B2[c] + u * u * u * P0[c])); }
      const leadN = pts.length;
      stroke.forEach((p) => pts.push(p));
      const acc = [0]; for (let k = 1; k < pts.length; k++) acc.push(acc[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      return { pts, acc, total: acc[acc.length - 1], lead: acc[leadN], start, travel, lag, head0, tail0, group };
    };
    // a ponta do primeiro tubo da logo já corre quando a cena abre
    const tubes = TUBES.map((tb, i) => makeTube({ d: tb.d, map: toStage, clip: tb.clip, from: tb.from, start: T.first + T.gap * i, travel: T.travel, lag: T.lag,
      head0: i === 0 ? 0.45 : 0, tail0: i === 0 ? 0.2 : 0, group: 'logo' }));

    // Saudação na tela ao lado (x de W a 2W), centrada, com o mesmo traço da logo.
    if (drawn) {
      const gs = s * 0.92;
      let width = 0; const items = [];
      [...greeting].forEach((ch, i, all) => {
        if (ch === ' ') { width += SPACE; return; }
        const [w, ds] = GLYPHS[ch]; items.push([width, ds]); width += w + (i < all.length - 1 && all[i + 1] !== ' ' ? GAP : 0);
      });
      const gx0 = W + W / 2 - (width * gs) / 2, gy0 = H / 2 + 90 * gs * K;
      const zEnd = toStage(1695.67, 485.2);
      const [g0, step, gTravel, gLag] = T.greet;
      let j = 0;
      items.forEach(([x0, ds]) => ds.forEach((d) => {
        const map = (x, y) => [gx0 + (x0 + x) * gs, gy0 + y * gs * K];
        tubes.push(j === 0
          // o primeiro tubo sai da ponta do Z e corre para a direita, levando a câmera até a saudação
          ? makeTube({ d, map, fromPoint: zEnd, start: T.exit[0], travel: T.exit[1], lag: T.exit[2], group: 'greet' })
          : makeTube({ d, map, from: GREET_FROM[j % GREET_FROM.length], reach: 1100, start: g0 + step * (j - 1), travel: gTravel, lag: gLag, group: 'greet' }));
        j++;
      }));
    } else {
      // Outra escrita: o tubo que sai do Z vira o sublinhado, e o texto surge acima dele, na fonte do sistema.
      const font = "300 112px 'Hanken Grotesk', system-ui, sans-serif";
      probe.font = font;
      const tw = Math.min(W * 0.8, probe.measureText(greeting).width);
      const x0 = W + W / 2 - tw / 2, base = H / 2 + 60;
      label = { text: greeting, font, x: x0, y: base, w: tw };
      tubes.push(makeTube({ d: `M0 0L${tw} 0`, map: (x, y) => [x0 + x, base + 64 + y], fromPoint: toStage(1695.67, 485.2), start: T.exit[0], travel: T.exit[1], lag: T.exit[2], group: 'greet' }));
    }
    const at = (tb, L) => {
      L = Math.max(0, Math.min(tb.total, L));
      let lo = 1, hi = tb.acc.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (tb.acc[m] < L) lo = m + 1; else hi = m; }
      const a = tb.pts[lo - 1], b = tb.pts[lo], u = (L - tb.acc[lo - 1]) / ((tb.acc[lo] - tb.acc[lo - 1]) || 1);
      return [mix(a[0], b[0], u), mix(a[1], b[1], u), lo];
    };
    const headOf = (tb, i, t) => mix(tb.lead * tb.head0, tb.total, seg(t, tb.start, tb.travel, 'sine.inOut'));
    const tailOf = (tb, i, t) => mix(tb.lead * tb.tail0, tb.lead, seg(t, tb.start + tb.lag, tb.travel, 'sine.inOut'));

    // Trilho da câmera: acompanha, com amortecimento, a ponta do tubo que está chegando; calculado uma vez.
    const FPS = 120, track = [];
    {
      let x = 0, y = 0, yaw = 0, init = false;
      for (let f = 0; f <= T.duration * FPS; f++) {
        const t = f / FPS;
        const i = 0;
        const tb = tubes[i], h = headOf(tb, i, t), p = at(tb, h), q = at(tb, h + 120);
        let ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
        if (!init) { x = p[0]; y = p[1]; yaw = ang; init = true; }
        while (ang - yaw > Math.PI) ang -= 2 * Math.PI; while (yaw - ang > Math.PI) ang += 2 * Math.PI;
        const a = 1 - Math.exp(-1 / FPS / 0.6), b = 1 - Math.exp(-1 / FPS / 1.6);
        x += (p[0] - x) * a; y += (p[1] - y) * a; yaw += (ang - yaw) * b;
        track.push([x, y, yaw]);
      }
    }
    const camAt = (t) => { const f = Math.max(0, Math.min(track.length - 1, t * FPS)), i = Math.floor(f), j = Math.min(track.length - 1, i + 1), u = f - i; return [0, 1, 2].map((c) => mix(track[i][c], track[j][c], u)); };

    const F = 1100;
    let cam;
    const setCam = (tg, ang, tilt, dist) => {
      const f = [Math.cos(ang), Math.sin(ang)], st = Math.sin(tilt), ct = Math.cos(tilt);
      const P = [tg[0] - f[0] * dist * st, tg[1] - f[1] * dist * st, dist * ct];
      const w = [(P[0] - tg[0]) / dist, (P[1] - tg[1]) / dist, P[2] / dist];
      const fw = f[0] * w[0] + f[1] * w[1];
      const v0 = [f[0] - w[0] * fw, f[1] - w[1] * fw, -w[2] * fw], vl = Math.hypot(...v0) || 1, v = v0.map((c) => c / vl);
      const u = [w[1] * v[2] - w[2] * v[1], w[2] * v[0] - w[0] * v[2], w[0] * v[1] - w[1] * v[0]];
      cam = { P, u, v, w, focus: dist };
    };
    const proj = (x, y, z) => {
      const rx = x - cam.P[0], ry = y - cam.P[1], rz = z - cam.P[2];
      const d = -(rx * cam.w[0] + ry * cam.w[1] + rz * cam.w[2]); if (d < 60) return null;
      const k = F / d;
      return [W / 2 + (rx * cam.u[0] + ry * cam.u[1] + rz * cam.u[2]) * k, H / 2 - (rx * cam.v[0] + ry * cam.v[1] + rz * cam.v[2]) * k, k, d];
    };

    // níveis de desfoque bem próximos: a troca de um nível para o outro ao longo do tubo não aparece
    const LEVELS = [0, 0.5, 1, 1.5, 2, 2.6, 3.2, 3.9, 4.6, 5.4, 6.3, 7.3, 8.4, 9.6, 11, 12.5, 14];
    const mk = () => { const c = document.createElement('canvas'); return { c, x: c.getContext('2d') }; };
    const layers = LEVELS.map(mk), shadow = mk(), scratch = mk();
    const finals = FINAL.map(([d, w, clip]) => ({ path: new Path2D(d), w, clip }));
    const PEN_STAGE = PEN * s * 1.03;
    const prep = (L, cw, ch, base) => { if (L.c.width !== cw || L.c.height !== ch) { L.c.width = cw; L.c.height = ch; } L.x.setTransform(1, 0, 0, 1, 0, 0); L.x.clearRect(0, 0, cw, ch); L.x.setTransform(base); L.x.lineCap = 'round'; L.x.lineJoin = 'round'; L.used = false; };

    function render(t) {
      // tema: no escuro a tinta é clara, então a sombra vira preto translúcido e o volume vem de um sombreado embaixo
      const { ground: GROUND, ink: INK, dark } = colors();
      const SHADOW = dark ? '#000' : INK, SHADOW_A = dark ? 0.5 : 0.16;
      // a composição inteira cabe na janela (o fundo é liso, então sobra só papel nas bordas)
      const cw = canvas.width, ch = canvas.height, fit = Math.min(cw / W, ch / H);
      const base = new DOMMatrix([fit, 0, 0, fit, (cw - W * fit) / 2, (ch - H * fit) / 2]);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.filter = 'none'; ctx.globalAlpha = 1;
      ctx.fillStyle = GROUND; ctx.fillRect(0, 0, cw, ch);

      // câmera: rente ao papel e de lado; sobe num plano só, devagar, até a vista de cima
      const k = seg(t, T.rise[0], T.rise[1], 'power2.inOut');
      const push = 1 + 0.04 * (1 - seg(t, T.settle[0], T.settle[1], 'power2.out'));
      // um movimento só, desenhado: rente ao papel, olhando ao longo da palavra; desliza para a direita,
      // sobe e gira devagar até ficar de cima, centrada
      const slide = seg(t, 0, 6.0, 'sine.inOut');
      const drift = 0.04 * Math.sin(t * 0.6) * (1 - k);
      // na abertura a câmera acompanha o primeiro tubo chegando; depois passa, sem tranco, ao movimento desenhado
      const c0 = camAt(t), w = seg(t, 0.4, 2.6, 'sine.inOut');
      let y0 = c0[2] - 0.75, y1 = -0.3 + drift;
      while (y0 - y1 > Math.PI) y0 -= 2 * Math.PI; while (y1 - y0 > Math.PI) y0 += 2 * Math.PI;
      const tx = mix(c0[0], mix(ox + 100, W / 2, slide), w), ty = mix(c0[1], mix(560, H / 2, k), w);
      // pan até a saudação: no meio do caminho a câmera inclina um pouco e se afasta; chega de novo de cima
      const pan = seg(t, T.pan[0], T.pan[1], 'power2.inOut'), arc = Math.sin(Math.PI * pan);
      const breathe = 1 + 0.025 * seg(t, T.breathe[0], T.breathe[1], 'sine.inOut');
      setCam([mix(tx, W / 2, k) + W * pan, mix(ty, H / 2, k)],
        mix(mix(y0, y1, w), -Math.PI / 2, seg(t, T.yaw[0], T.yaw[1], 'power2.inOut')) - 0.1 * arc,
        mix(1.18, 0, k) + 0.3 * arc,
        mix(mix(420, 560, w), F / push, Math.pow(k, 0.9)) * (1 + 0.1 * arc) / breathe);
      const open = seg(t, 0, 1.8, 'power2.out');
      const dof = Math.max((1 - seg(t, T.dofOff[0], T.dofOff[1], 'power2.inOut')) * mix(2.4, 1, open), 1.4 * arc);
      const flat = seg(t, T.flat[0], T.flat[1], 'power2.inOut'), flat2 = seg(t, T.flat2[0], T.flat2[1], 'power2.inOut');
      const swap = seg(t, T.swap[0], T.swap[1], 'sine.inOut');

      layers.forEach((L) => prep(L, cw, ch, base)); prep(shadow, cw, ch, base);
      const sheen = [];
      tubes.forEach((tb, i) => {
        const head = headOf(tb, i, t), tail = tailOf(tb, i, t);
        if (head <= tail + 0.5) return;
        const logo = tb.group === 'logo', up = 1 - (logo ? flat : flat2), tubeH = 7 * up;
        let prev = null, prevS = null;
        const a0 = at(tb, tail), a1 = at(tb, head);
        const P = [[a0[0], a0[1]]]; for (let j = a0[2]; j < a1[2]; j++) P.push(tb.pts[j]); P.push([a1[0], a1[1]]);
        let L = tail;
        for (let j = 0; j < P.length; j++) {
          if (j > 0) L += Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]);
          const alpha = logo && L > tb.lead ? 1 - swap : 1;
          const p = proj(P[j][0], P[j][1], tubeH), ps = tubeH > 0.2 ? proj(P[j][0] + tubeH * 0.9, P[j][1] + tubeH * 1.2, 0) : null;
          if (p && prev && alpha > 0) {
            const blur = dof * Math.min(13, Math.abs(p[3] - cam.focus) / cam.focus * 9);
            let li = 0; while (li < LEVELS.length - 1 && blur > (LEVELS[li] + LEVELS[li + 1]) / 2) li++;
            const Ly = layers[li]; Ly.used = true; Ly.x.globalAlpha = alpha; Ly.x.strokeStyle = INK;
            const wd = Math.min(90, PEN_STAGE * p[2]);
            Ly.x.lineWidth = wd; Ly.x.beginPath(); Ly.x.moveTo(prev[0], prev[1]); Ly.x.lineTo(p[0], p[1]); Ly.x.stroke();
            if (wd > 3 && up > 0.01) sheen.push([li, prev, p, wd, alpha * up]);
          }
          if (ps && prevS && alpha > 0) {
            shadow.used = true; shadow.x.strokeStyle = SHADOW; shadow.x.globalAlpha = alpha * up;
            shadow.x.lineWidth = Math.min(90, PEN_STAGE * ps[2] * 1.15); shadow.x.beginPath(); shadow.x.moveTo(prevS[0], prevS[1]); shadow.x.lineTo(ps[0], ps[1]); shadow.x.stroke();
          }
          prev = p; prevS = ps;
        }
      });
      // Volume do tubo, como a luz num cilindro (luz fixa vinda de cima). No claro, um reflexo suave cor de papel
      // do lado da luz; no escuro (tubo claro), uma penumbra do lado oposto. Uma folha só, com a faixa de todos
      // os tubos desenhada opaca (sem sobreposição nem emendas) e desfocada, é recortada dentro do corpo de cada
      // camada (source-atop). Assim o encontro de dois níveis de foco recebe o mesmo sombreado dos dois lados.
      // O deslocamento segue a normal de forma contínua: nunca troca de lado.
      if (sheen.length) {
        const lx = 0.25, ly = -0.97, sign = dark ? -1 : 1, x = scratch.x;
        prep(scratch, cw, ch, base);
        x.strokeStyle = GROUND;
        const widths = [];
        sheen.forEach(([, a, b, wd, al]) => {
          const dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy) || 1, nx = dy / n, ny = -dx / n;
          const off = sign * wd * (dark ? 0.3 : 0.22) * (nx * lx + ny * ly);
          x.globalAlpha = al; x.lineWidth = wd * (dark ? 0.42 : 0.34);
          x.beginPath(); x.moveTo(a[0] + nx * off, a[1] + ny * off); x.lineTo(b[0] + nx * off, b[1] + ny * off); x.stroke();
          widths.push(wd);
        });
        widths.sort((p, q) => p - q);
        const soft = `blur(${Math.max(0.6, widths[widths.length >> 1] * fit * 0.16)}px)`;
        layers.forEach((Ly) => {
          if (!Ly.used) return;
          Ly.x.save();
          Ly.x.setTransform(1, 0, 0, 1, 0, 0);
          Ly.x.globalCompositeOperation = 'source-atop';
          Ly.x.filter = soft;
          Ly.x.globalAlpha = dark ? 0.3 : 0.24;
          Ly.x.drawImage(scratch.c, 0, 0);
          Ly.x.restore();
        });
      }
      const fade = seg(t, 0, 1.0, 'power2.out');
      if (shadow.used) { ctx.filter = `blur(${7 * fit}px)`; ctx.globalAlpha = SHADOW_A; ctx.drawImage(shadow.c, 0, 0); }
      ctx.globalAlpha = 1;
      layers.forEach((Ly, i) => { if (!Ly.used) return; ctx.filter = LEVELS[i] ? `blur(${LEVELS[i] * fit}px)` : 'none'; ctx.drawImage(Ly.c, 0, 0); });
      ctx.filter = 'none';
      if (fade < 1) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1 - fade; ctx.fillStyle = GROUND; ctx.fillRect(0, 0, cw, ch); ctx.globalAlpha = 1; }

      if (label) {
        // texto da saudação na mesma câmera, chegando enquanto o sublinhado assenta
        const show = seg(t, T.greet[0] + 0.4, 1.6, 'power2.out');
        if (show > 0) {
          const c = [W + W / 2, H / 2], q0 = proj(c[0], c[1], 0), q1 = proj(c[0] + 100, c[1], 0), q2 = proj(c[0], c[1] + 100, 0);
          if (q0 && q1 && q2) {
            const camM = new DOMMatrix([(q1[0] - q0[0]) / 100, (q1[1] - q0[1]) / 100, (q2[0] - q0[0]) / 100, (q2[1] - q0[1]) / 100, q0[0], q0[1]]).multiply(new DOMMatrix([1, 0, 0, 1, -c[0], -c[1]]));
            ctx.setTransform(base.multiply(camM)); ctx.globalAlpha = show; ctx.fillStyle = INK; ctx.font = label.font; ctx.textBaseline = 'alphabetic';
            ctx.fillText(label.text, label.x, label.y + 24 * (1 - show), label.w);
            ctx.globalAlpha = 1;
          }
        }
      }
      if (swap > 0) {
        // a logo exata segue a câmera: mapa afim tirado de três pontos projetados em volta do centro dela
        // (exato com a câmera de cima; na leve inclinação do pan, a diferença não aparece)
        const c = [W / 2, H / 2], q0 = proj(c[0], c[1], 0), q1 = proj(c[0] + 100, c[1], 0), q2 = proj(c[0], c[1] + 100, 0);
        const camM = new DOMMatrix([(q1[0] - q0[0]) / 100, (q1[1] - q0[1]) / 100, (q2[0] - q0[0]) / 100, (q2[1] - q0[1]) / 100, q0[0], q0[1]]).multiply(new DOMMatrix([1, 0, 0, 1, -c[0], -c[1]]));
        const m = base.multiply(camM).multiply(new DOMMatrix([s, 0, 0, s * K, ox - 248 * s, oy - 227 * s]));
        ctx.setTransform(m); ctx.globalAlpha = swap; ctx.strokeStyle = INK; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        finals.forEach((f) => { ctx.save(); if (f.clip) ctx.clip(clipPath); ctx.lineWidth = f.w; ctx.stroke(f.path); ctx.restore(); });
        ctx.globalAlpha = 1;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    render.duration = T.duration;
    return render;
  }
export { RotazSplash };
