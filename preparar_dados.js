// Arquivos obrigatórios: ITINERARIO_TRANSPORTE_COLETIVO, PONTO_ONIBUS, SETOR_CENSITARIO_2022, VILA_FAVELA.
// Critérios extras de distância (escolas, saúde, parques...) são declarados em criterios.json.
// Ingestão dos GeoJSON abertos da PBH (BHMap, EPSG:31983) -> dados.js usado pelo index.html
// Uso:  node preparar_dados.js
// Sem dependências. Rode de novo sempre que baixar versões novas dos arquivos .json.
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const CELULA = 100;          // tamanho da célula da grade (m)
const CAP_VILA = 5000;       // distância máxima calculada até vilas (m)
const TOL_SIMPLIFICA = 3;    // simplificação dos itinerários (m)
const DIST_MAX_PONTO = 60;   // ponto a mais que isso do traçado não entra na rota (m)
const PENAL_LADO = 20;       // penalidade (m) p/ ponto do lado esquerdo do sentido de viagem
// sublinhas que não representam o serviço do dia a dia
const ESPECIAL = /CARNAVAL|MADRUG|DESVIO|FEIRA|EVENTO|ELEI|NOTURNO/i;

function carregar(nome) {
  const buf = fs.readFileSync(path.join(DIR, nome + '.json'));
  let s = buf.toString('utf8');
  if (s.includes('�')) s = buf.toString('latin1');
  const j = JSON.parse(s);
  const crs = j.crs && j.crs.properties && j.crs.properties.name || '';
  if (!/31983/.test(crs)) throw new Error(`${nome}: esperado EPSG:31983, veio "${crs}"`);
  return j.features;
}

console.log('Lendo arquivos...');
const fItin = carregar('ITINERARIO_TRANSPORTE_COLETIVO');
const fPontos = carregar('PONTO_ONIBUS');
const fSetor = carregar('SETOR_CENSITARIO_2022');
const fVila = carregar('VILA_FAVELA');


// ---------- extensão / origem ----------
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const f of fSetor) for (const pol of f.geometry.coordinates) for (const [x, y] of pol[0]) {
  if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
}
const X0 = Math.floor(minX / CELULA) * CELULA, Y0 = Math.floor(minY / CELULA) * CELULA;
const NX = Math.ceil((maxX - X0) / CELULA), NY = Math.ceil((maxY - Y0) / CELULA);
const rx = x => Math.round(x - X0), ry = y => Math.round(y - Y0);

// ---------- itinerários ----------
function simplificar(pts, tol) {
  const n = pts.length; if (n < 3) return pts;
  const manter = new Uint8Array(n); manter[0] = manter[n - 1] = 1;
  const pilha = [[0, n - 1]];
  while (pilha.length) {
    const [a, b] = pilha.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let pior = -1, dPior = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] - ax, py = pts[i][1] - ay;
      let t = L2 ? (px * dx + py * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - t * dx, ey = py - t * dy, d = ex * ex + ey * ey;
      if (d > dPior) { dPior = d; pior = i; }
    }
    if (pior >= 0) { manter[pior] = 1; pilha.push([a, pior], [pior, b]); }
  }
  return pts.filter((_, i) => manter[i]);
}

const itins = fItin.map(f => {
  const p = f.properties;
  let pts = simplificar(f.geometry.coordinates, TOL_SIMPLIFICA).map(([x, y]) => [rx(x), ry(y)]);
  pts = pts.filter((q, i) => i === 0 || q[0] !== pts[i - 1][0] || q[1] !== pts[i - 1][1]);
  const acum = [0];
  for (let i = 1; i < pts.length; i++) acum.push(acum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { linha: p.CODIGO_LINHA, sub: p.NUMERO_SUBLINHA, pc: p.NUMERO_PC, move: p.TIPO_TRANSPORTE === 'MOVE', pts, acum, grupo: null, paradas: [] };
});
const itinsPorLinha = new Map();
itins.forEach((it, i) => { if (!itinsPorLinha.has(it.linha)) itinsPorLinha.set(it.linha, []); itinsPorLinha.get(it.linha).push(i); });

// projeção de um ponto no traçado: prefere o lado direito do sentido de viagem (mão brasileira)
function projetar(it, px, py) {
  const { pts, acum } = it;
  let melhor = Infinity, d0 = 0, ch = 0, esq = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1], dx = pts[i][0] - ax, dy = pts[i][1] - ay;
    const L2 = dx * dx + dy * dy; if (!L2) continue;
    let t = ((px - ax) * dx + (py - ay) * dy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
    const lado = dx * (py - ay) - dy * (px - ax) > 0 ? 1 : 0;
    const custo = d + (lado && d > 1 ? PENAL_LADO : 0);
    if (custo < melhor) { melhor = custo; d0 = d; ch = acum[i - 1] + t * Math.sqrt(L2); esq = lado; }
  }
  return { custo: melhor, d: d0, ch, esq };
}

// ---------- pontos de ônibus ----------
const nos = [], noPorCoord = new Map();
const linhas = [], linhaIdx = new Map();   // [codigo, nome]
const grupos = new Map();                  // linha|sub|origem -> {linha, sub, origem, pontos:[no]}
for (const f of fPontos) {
  const p = f.properties, [x, y] = f.geometry.coordinates;
  const k = x + ',' + y;
  let no = noPorCoord.get(k);
  if (no === undefined) { no = nos.length; nos.push([rx(x), ry(y)]); noPorCoord.set(k, no); }
  if (!linhaIdx.has(p.COD_LINHA)) { linhaIdx.set(p.COD_LINHA, linhas.length); linhas.push([p.COD_LINHA, p.NOME_LINHA]); }
  const gk = p.COD_LINHA + '|' + p.NOME_SUB_LINHA + '|' + p.ORIGEM;
  if (!grupos.has(gk)) grupos.set(gk, { linha: p.COD_LINHA, sub: p.NOME_SUB_LINHA, origem: p.ORIGEM, pontos: [] });
  grupos.get(gk).pontos.push(no);
}

// casa cada grupo (linha, sublinha, origem) com o itinerário da mesma linha que melhor encaixa
console.log('Casando pontos com itinerários...');
const gruposPorLinha = new Map();
for (const g of grupos.values()) { if (!gruposPorLinha.has(g.linha)) gruposPorLinha.set(g.linha, []); gruposPorLinha.get(g.linha).push(g); }
let semItin = 0, ruins = 0, casados = 0;
const custos = [];
for (const [linha, gs] of gruposPorLinha) {
  const cand = itinsPorLinha.get(linha);
  if (!cand) { semItin += gs.length; continue; }
  const pares = [];
  gs.forEach((g, gi) => cand.forEach(ii => {
    let s = 0; const proj = g.pontos.map(no => { const r = projetar(itins[ii], nos[no][0], nos[no][1]); s += Math.min(r.custo, 300); return r; });
    pares.push({ gi, ii, custo: s / g.pontos.length, proj });
  }));
  pares.sort((a, b) => a.custo - b.custo);
  const gUsado = new Set(), iUsado = new Set(), escolha = [];
  for (const p of pares) if (!gUsado.has(p.gi) && !iUsado.has(p.ii)) { gUsado.add(p.gi); iUsado.add(p.ii); escolha.push(p); }
  for (const p of escolha) {
    const g = gs[p.gi];
    if (p.custo > 60) { ruins++; continue; }
    casados++; custos.push(p.custo);
    const it = itins[p.ii]; it.grupo = g;
    const ps = g.pontos.map((no, k) => ({ no, ch: p.proj[k].ch, d: p.proj[k].d })).filter(q => q.d <= DIST_MAX_PONTO);
    ps.sort((a, b) => a.ch - b.ch);
    it.paradas = ps.filter((q, k) => k === 0 || q.no !== ps[k - 1].no);
  }
}
custos.sort((a, b) => a - b);
console.log(`  grupos de pontos: ${grupos.size} | casados: ${casados} | sem itinerário no arquivo: ${semItin} | encaixe ruim: ${ruins}`);
console.log(`  custo de encaixe (m) mediana ${custos[custos.length >> 1].toFixed(1)}  p95 ${custos[Math.floor(custos.length * .95)].toFixed(1)}`);

const itOut = itins.filter(it => it.grupo && it.paradas.length >= 2 && !ESPECIAL.test(it.grupo.sub));
console.log(`  itinerários regulares usados no cálculo: ${itOut.length} de ${itins.length}`);

// linhas regulares que servem cada ponto (inclui linhas sem itinerário no arquivo)
const linhasDoNo = nos.map(() => new Set());
for (const g of grupos.values()) if (!ESPECIAL.test(g.sub)) for (const no of g.pontos) linhasDoNo[no].add(linhaIdx.get(g.linha));

// ---------- grade + setores censitários ----------
console.log('Montando grade e setores...');
function dentro(aneis, x, y) {          // par-ímpar sobre todos os anéis (trata furos)
  let c = false;
  for (const an of aneis) for (let i = 0, j = an.length - 1; i < an.length; j = i++) {
    const yi = an[i][1], yj = an[j][1];
    if ((yi > y) !== (yj > y) && x < (an[j][0] - an[i][0]) * (y - yi) / (yj - yi) + an[i][0]) c = !c;
  }
  return c;
}
function caixa(aneis) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const an of aneis) for (const [x, y] of an) { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
  return [a, b, c, d];
}
function areaAnel(an) { let s = 0; for (let i = 0, j = an.length - 1; i < an.length; j = i++) s += an[j][0] * an[i][1] - an[i][0] * an[j][1]; return Math.abs(s) / 2; }

const bairros = [], bairroIdx = new Map(), regionais = [], regIdx = new Map();
const idx = (lista, mapa, v) => { if (!mapa.has(v)) { mapa.set(v, lista.length); lista.push(v); } return mapa.get(v); };
const celBairro = new Int16Array(NX * NY).fill(-1), celReg = new Int8Array(NX * NY).fill(-1), celDens = new Uint16Array(NX * NY);
for (const f of fSetor) {
  const p = f.properties;
  const b = idx(bairros, bairroIdx, p.BAIRRO_CONSIDERADO_SETOR || '—'), r = idx(regionais, regIdx, p.REGIONAL_CONSIDERADA_SETOR || '—');
  let area = 0;
  for (const pol of f.geometry.coordinates) { area += areaAnel(pol[0]); for (let h = 1; h < pol.length; h++) area -= areaAnel(pol[h]); }
  const dens = Math.min(65535, Math.round((p.QT_TOT_PESSOAS_RES_DOMC || 0) / (area / 1e4)));   // hab/ha
  for (const pol of f.geometry.coordinates) {
    const aneis = pol.map(an => an.map(([x, y]) => [x - X0, y - Y0]));
    const [a, b0, c, d] = caixa(aneis);
    for (let iy = Math.max(0, Math.floor(b0 / CELULA)); iy <= Math.min(NY - 1, Math.floor(d / CELULA)); iy++)
      for (let ix = Math.max(0, Math.floor(a / CELULA)); ix <= Math.min(NX - 1, Math.floor(c / CELULA)); ix++)
        if (dentro(aneis, (ix + .5) * CELULA, (iy + .5) * CELULA)) { const k = iy * NX + ix; celBairro[k] = b; celReg[k] = r; celDens[k] = dens; }
  }
}

// ---------- vilas e favelas ----------
console.log('Calculando distância às vilas e favelas...');
const dVila = new Uint16Array(NX * NY).fill(CAP_VILA), dLot = new Uint16Array(NX * NY).fill(CAP_VILA);
const vilas = fVila.map(f => {
  const p = f.properties, lot = /Loteamento/i.test(p.DESC_LOCALIDADE) ? 1 : 0;
  const alvo = lot ? dLot : dVila;
  const pols = f.geometry.coordinates.map(pol => pol.map(an => an.map(([x, y]) => [rx(x), ry(y)])));
  for (const aneis of pols) {
    const [a, b, c, d] = caixa(aneis);
    const ix0 = Math.max(0, Math.floor((a - CAP_VILA) / CELULA)), ix1 = Math.min(NX - 1, Math.floor((c + CAP_VILA) / CELULA));
    const iy0 = Math.max(0, Math.floor((b - CAP_VILA) / CELULA)), iy1 = Math.min(NY - 1, Math.floor((d + CAP_VILA) / CELULA));
    for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
      const k = iy * NX + ix; if (celBairro[k] < 0) continue;
      const x = (ix + .5) * CELULA, y = (iy + .5) * CELULA;
      const fora = Math.max(a - x, x - c, b - y, y - d, 0);       // distância mínima possível (caixa)
      if (fora >= alvo[k]) continue;
      let m2 = alvo[k] * alvo[k];
      if (dentro(aneis, x, y)) m2 = 0;
      else for (const an of aneis) for (let i = 1; i < an.length; i++) {
        const ax = an[i - 1][0], ay = an[i - 1][1], dx = an[i][0] - ax, dy = an[i][1] - ay, L2 = dx * dx + dy * dy;
        let t = L2 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = x - ax - t * dx, ey = y - ay - t * dy, q = ex * ex + ey * ey;
        if (q < m2) m2 = q;
      }
      alvo[k] = Math.round(Math.sqrt(m2));
    }
  }
  return { nome: p.NOME_LOCALIDADE, apelido: p.APELIDO_LOCALIDADE || '', lot, pop: p.QTDE_POPULACAO_EXISTENTE || 0, dom: p.QTDE_DOMICILIO || 0,
           pols: pols.map(pol => pol.map(an => an.flat())) };
});

// ---------- saída ----------
const cel = { k: [], b: [], r: [], dens: [], dv: [], dl: [] };
for (let k = 0; k < NX * NY; k++) if (celBairro[k] >= 0) { cel.k.push(k); cel.b.push(celBairro[k]); cel.r.push(celReg[k]); cel.dens.push(celDens[k]); cel.dv.push(dVila[k]); cel.dl.push(dLot[k]); }
const nlOff = [0], nlIdx = [];
for (const s of linhasDoNo) { for (const l of s) nlIdx.push(l); nlOff.push(nlIdx.length); }

// ---------- critérios extras (criterios.json) ----------
// lat/lon -> UTM 23S (SIRGAS 2000), para aceitar GeoJSON em coordenadas geográficas
function paraUTM(lon, lat) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, n = f / (2 - f), A = a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64), e2n = 2 * Math.sqrt(n) / (1 + n);
  const al = [n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16, 13 * n * n / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240];
  const phi = lat * Math.PI / 180, dl = (lon + 45) * Math.PI / 180, s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - e2n * Math.atanh(e2n * s));
  const x = Math.atan2(t, Math.cos(dl)), e = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let E = e, N = x;
  for (let j = 1; j <= 3; j++) { E += al[j - 1] * Math.cos(2 * j * x) * Math.sinh(2 * j * e); N += al[j - 1] * Math.sin(2 * j * x) * Math.cosh(2 * j * e); }
  return [5e5 + k0 * A * E, 1e7 + k0 * A * N];
}
function carregarCriterio(arquivo) {
  const buf = fs.readFileSync(path.join(DIR, arquivo));
  let s = buf.toString('utf8'); if (s.includes('�')) s = buf.toString('latin1');
  const j = JSON.parse(s), crs = j.crs && j.crs.properties && j.crs.properties.name || '';
  let conv;
  if (/31983/.test(crs)) conv = (x, y) => [rx(x), ry(y)];
  else if (!crs || /CRS84|4326|4674/.test(crs)) conv = (p, q) => { const [E, N] = p < -30 ? paraUTM(p, q) : paraUTM(q, p); return [rx(E), ry(N)]; };   // aceita lon,lat ou lat,lon
  else throw new Error(`${arquivo}: sistema de coordenadas não suportado (${crs}). Use EPSG:31983 ou latitude/longitude.`);
  return { feicoes: j.features || [], conv };
}
// menor distância de cada célula a um conjunto de anéis/linhas (0 dentro de polígono), limitada a CAP_VILA
function distAneis(alvo, aneis, fechado) {
  const [a, b, c, d] = caixa(aneis);
  const ix0 = Math.max(0, Math.floor((a - CAP_VILA) / CELULA)), ix1 = Math.min(NX - 1, Math.floor((c + CAP_VILA) / CELULA));
  const iy0 = Math.max(0, Math.floor((b - CAP_VILA) / CELULA)), iy1 = Math.min(NY - 1, Math.floor((d + CAP_VILA) / CELULA));
  for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
    const k = iy * NX + ix; if (celBairro[k] < 0) continue;
    const x = (ix + .5) * CELULA, y = (iy + .5) * CELULA;
    const lim = Math.min(alvo[k], CAP_VILA), fora = Math.max(a - x, x - c, b - y, y - d, 0);
    if (fora >= lim) continue;
    let m2 = lim * lim;
    if (fechado && dentro(aneis, x, y)) m2 = 0;
    else for (const an of aneis) for (let i = 1; i < an.length; i++) {
      const ax = an[i - 1][0], ay = an[i - 1][1], dx = an[i][0] - ax, dy = an[i][1] - ay, L2 = dx * dx + dy * dy;
      let t = L2 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - ax - t * dx, ey = y - ay - t * dy, q = ex * ex + ey * ey;
      if (q < m2) m2 = q;
    }
    if (m2 < lim * lim) alvo[k] = Math.round(Math.sqrt(m2));
  }
}
const extras = [];
const arqCrit = path.join(DIR, 'criterios.json');
if (fs.existsSync(arqCrit)) {
  console.log('Lendo criterios.json...');
  const conf = JSON.parse(fs.readFileSync(arqCrit, 'utf8')).criterios || [];
  const ids = new Set();
  for (const c of conf) {
    const erro = m => { throw new Error(`criterios.json, critério "${c.id || c.nome || '?'}": ${m}`); };
    if (!/^[a-z0-9_]+$/i.test(c.id || '')) erro('"id" é obrigatório e só pode ter letras, números e _');
    if (ids.has(c.id)) erro('"id" repetido'); ids.add(c.id);
    // "fontes" junta vários arquivos num critério só (ex.: EMEIs + escolas de ensino fundamental); vale o item mais próximo de qualquer um
    const fontes = Array.isArray(c.fontes) ? c.fontes : c.arquivo ? [{ arquivo: c.arquivo, cor: c.cor, tipo: c.rotulo }] : [];
    if (!c.nome || !fontes.length || fontes.some(o => !o || !o.arquivo)) erro('"nome" e "arquivo" (ou "fontes", cada uma com "arquivo") são obrigatórios');
    if (c.melhor !== 'perto' && c.melhor !== 'longe') erro('"melhor" deve ser "perto" ou "longe"');
    if (!(c.otimo >= 0) || !(c.limite >= 0) || c.otimo === c.limite) erro('"otimo" e "limite" devem ser distâncias em metros, diferentes entre si');
    if ((c.melhor === 'perto') !== (c.otimo < c.limite)) erro(c.melhor === 'perto' ? 'com melhor = "perto", "otimo" deve ser menor que "limite"' : 'com melhor = "longe", "otimo" deve ser maior que "limite"');
    const d = new Uint16Array(NX * NY).fill(65535), f = [], fontesOk = [];
    for (const fonte of fontes) {
    if (!fs.existsSync(path.join(DIR, fonte.arquivo))) { console.warn(`  AVISO: ${fonte.arquivo} não está na pasta; ignorado no critério "${c.id}".`); continue; }
    const { feicoes, conv } = carregarCriterio(fonte.arquivo);
    const s = fontesOk.length; fontesOk.push({ tipo: fonte.tipo || '', cor: fonte.cor || c.cor || '#e65100' });
    for (const ft of feicoes) {
      const g = ft.geometry; if (!g) continue;
      const p = ft.properties || {}, n = String(p[c.campoNome || 'NOME'] ?? p.NOME ?? p.nome ?? p.name ?? '');
      const anel = an => an.map(q => conv(q[0], q[1]));
      const pontos = g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : null;
      const linhas_ = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : null;
      const pols = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
      if (pontos) for (const q of pontos) {
        const [x, y] = conv(q[0], q[1]); f.push({ n, s, g: 0, c: [x, y] });
        for (let k = 0; k < NX * NY; k++) { if (celBairro[k] < 0) continue;
          const v = Math.hypot((k % NX + .5) * CELULA - x, (Math.floor(k / NX) + .5) * CELULA - y); if (v < d[k]) d[k] = v; }
      } else if (linhas_) { const aneis = linhas_.map(anel); distAneis(d, aneis, false); f.push({ n, s, g: 1, c: aneis.map(a => a.flat()) }); }
      else if (pols) for (const pol of pols) { const aneis = pol.map(anel); distAneis(d, aneis, true); f.push({ n, s, g: 2, c: aneis.map(a => a.flat()) }); }
    }
    }
    if (!f.length) { console.warn(`  AVISO: critério "${c.id}" ignorado (nenhum arquivo encontrado ou sem feições com geometria).`); continue; }
    extras.push({ id: c.id, nome: c.nome, rotulo: c.rotulo || c.nome, melhor: c.melhor, otimo: c.otimo, limite: c.limite,
      peso: Math.max(0, Math.min(10, c.peso ?? 1)), eliminar: !!c.eliminar, mostrar: c.mostrar !== false, cor: fontesOk[0].cor, fontes: fontesOk, f, dGrade: d });
    console.log(`  critério "${c.id}": ${f.length} feições de ${fontesOk.length} arquivo(s)`);
  }
}

for (const e of extras) { e.d = []; for (let k = 0; k < NX * NY; k++) if (celBairro[k] >= 0) e.d.push(e.dGrade[k]); delete e.dGrade; }

const saida = {
  geradoEm: new Date().toISOString(),
  epsg: 31983, x0: X0, y0: Y0, celula: CELULA, nx: NX, ny: NY, capVila: CAP_VILA,
  nos: nos.flat(), nlOff, nlIdx, linhas, bairros, regionais, cel, vilas, extras,
  itins: itOut.map(it => ({
    l: linhaIdx.get(it.linha), sub: it.grupo.sub, origem: it.grupo.origem, pc: it.pc, move: it.move ? 1 : 0,
    pts: it.pts.flat(), pn: it.paradas.map(p => p.no), pc_: it.paradas.map(p => Math.round(p.ch)),
  })),
};
const destino = path.join(DIR, 'dados.js');
fs.writeFileSync(destino, 'window.DADOS=' + JSON.stringify(saida) + ';');
console.log(`OK: ${destino} (${(fs.statSync(destino).size / 1e6).toFixed(1)} MB)`);
console.log(`  ${nos.length} pontos de ônibus distintos | ${linhas.length} linhas | ${cel.k.length} células de ${CELULA} m | ${vilas.length} vilas/favelas/loteamentos | ${extras.length} critérios extras | ${bairros.length} bairros`);
