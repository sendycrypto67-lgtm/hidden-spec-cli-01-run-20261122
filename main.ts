// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// Section 3: split a file's text at its own line break (CRLF when its first LF follows a CR, else LF);
// `final` is true when the text ends with that break (the empty piece after it is not a line).
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

// Section 3: join lines with `br`, adding a final break only when `final`; no lines means empty text.
function joinFile(br: string, lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

// Section 5: line equality at a tier (0 exact, 1 trailing spaces/tabs ignored, 2 leading and trailing ignored).
function eqAt(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

// Section 5: the first tier (0, then 1, then 2; only 0 when strict) where O occurs at least once, with every
// 0-based start position at that tier (occurrences may overlap); null when O occurs at no tier.
function findOccurrence(fileLines: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  if (O.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = 0; i + O.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!eqAt(tier, fileLines[i + j]!, O[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// ctx: array of [oIndex, nIndex] pairs; the N line at nIndex is a context line and is written as fileLines[pos + oIndex], never from the patch.
// Section 5: replace the k lines at pos with N; at tier 2 a non-context, non-empty, non-whitespace-only N line
// starting with P (leading spaces/tabs of O's first line) has that P replaced by F (leading spaces/tabs of the
// file's first matched line); at tiers 0 and 1 N lines are written as they are. Returns a new array.
function applyReplacement(fileLines: string[], O: string[], N: string[], pos: number, tier: number, ctx: [number, number][]): string[] {
  const ctxMap = new Map<number, number>(ctx.map(([o, n]) => [n, o]));
  const F = tier === 2 ? (/^[ \t]*/.exec(fileLines[pos] ?? '')?.[0] ?? '') : '';
  const P = tier === 2 ? (/^[ \t]*/.exec(O[0] ?? '')?.[0] ?? '') : '';
  const out = N.map((line, n) => {
    const o = ctxMap.get(n);
    if (o !== undefined) return fileLines[pos + o]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) return F + line.slice(P.length);
    return line;
  });
  return [...fileLines.slice(0, pos), ...out, ...fileLines.slice(pos + O.length)];
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

type UnifiedHunk = { a: number; body: string[] };
type UnifiedSection = { old: string | null; nw: string | null; creation: boolean; deletion: boolean; hunks: UnifiedHunk[] };

const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
function headerPath(line: string): string | null {
  const t = line.slice(4).split('\t')[0]!.trim();
  return t === '/dev/null' ? null : stripAB(t);
}

// Section 6 parser: split the patch into sections with their hunks. Throws Exit2 on a parse fault.
function parseUnified(lines: string[]): UnifiedSection[] {
  type Raw = { diffOld: string | null; diffNew: string | null; pairOld: string | null; pairNew: string | null; hasPair: boolean; renOld: string | undefined; renNew: string | undefined; creation: boolean; deletion: boolean; hunks: UnifiedHunk[] };
  const sections: UnifiedSection[] = [];
  let cur: Raw | null = null;
  let inHeader = false;
  const pushCur = (): void => {
    if (cur === null) return;
    const old = cur.hasPair ? cur.pairOld : (cur.renOld !== undefined ? cur.renOld : cur.diffOld);
    const nw = cur.hasPair ? cur.pairNew : (cur.renNew !== undefined ? cur.renNew : cur.diffNew);
    sections.push({ old, nw, creation: cur.creation, deletion: cur.deletion, hunks: cur.hunks });
    cur = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      pushCur();
      cur = { diffOld: m[1]!, diffNew: m[2]!, pairOld: null, pairNew: null, hasPair: false, renOld: undefined, renNew: undefined, creation: false, deletion: false, hunks: [] };
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      pushCur();
      cur = { diffOld: null, diffNew: null, pairOld: headerPath(line), pairNew: headerPath(lines[i + 1]!), hasPair: true, renOld: undefined, renNew: undefined, creation: false, deletion: false, hunks: [] };
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(line);
      if (!m || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) { body.push(b); j++; continue; }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: parseInt(m[1]!, 10), body });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) { if (cur.renOld === undefined) cur.renOld = line.slice(12).trim(); i++; continue; }
      if (line.startsWith('rename to ')) { if (cur.renNew === undefined) cur.renNew = line.slice(10).trim(); i++; continue; }
      if (line.startsWith('new file mode')) { cur.creation = true; i++; continue; }
      if (line.startsWith('deleted file mode')) { cur.deletion = true; i++; continue; }
      i++;
      continue;
    }
    i++;
  }
  pushCur();
  return sections;
}

const recordedMoves: [string, string][] = [];

// Apply a section's hunks in order to a file's text; throws Fail on a hunk failure.
function applyHunks(before: string, hunks: UnifiedHunk[], strict: boolean, path: string): string {
  let cur = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: string[] = [];
    const ctx: [number, number][] = [];
    let lastCtxPlus = -1;
    for (let bi = 0; bi < h.body.length; bi++) {
      const b = h.body[bi]!;
      if (b === '' || b.startsWith(' ')) { O.push(b.slice(1)); N.push(b.slice(1)); ctx.push([O.length - 1, N.length - 1]); lastCtxPlus = bi; }
      else if (b.startsWith('-')) O.push(b.slice(1));
      else if (b.startsWith('+')) { N.push(b.slice(1)); lastCtxPlus = bi; }
    }
    const noNl = lastCtxPlus >= 0 && h.body[lastCtxPlus + 1] !== undefined && h.body[lastCtxPlus + 1]!.startsWith('\\');
    if (O.length > 0) {
      const occ = findOccurrence(cur.lines, O, strict);
      if (occ === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = occ.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of occ.positions) {
        const dist = Math.abs(p - target);
        if (dist < best) { best = dist; pos = p; }
      }
      const atEnd = pos + O.length === cur.lines.length;
      const newLines = applyReplacement(cur.lines, O, N, pos, occ.tier, ctx);
      cur = { br: cur.br, lines: newLines, final: atEnd ? !noNl : cur.final };
    } else {
      const insertPos = Math.max(0, Math.min(h.a + d, cur.lines.length));
      const atEnd = insertPos === cur.lines.length;
      const newLines = [...cur.lines.slice(0, insertPos), ...N, ...cur.lines.slice(insertPos)];
      cur = { br: cur.br, lines: newLines, final: N.length === 0 ? cur.final : atEnd ? !noNl : cur.final };
    }
    d += N.length - O.length;
  }
  return joinFile(cur.br, cur.lines, cur.final);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => (tree: Tree) => {
    const oldP = sec.old;
    const newP = sec.nw;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.creation || oldP === null) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let finalFlag = false;
      let foundPlus = false;
      for (const h of sec.hunks) {
        for (let bi = 0; bi < h.body.length; bi++) {
          const b = h.body[bi]!;
          if (b.startsWith('+')) {
            plus.push(b.slice(1));
            const nxt = h.body[bi + 1];
            finalFlag = !(nxt !== undefined && nxt.startsWith('\\'));
            foundPlus = true;
          }
        }
      }
      tree.now.set(newP, joinFile('\n', plus, foundPlus ? finalFlag : false));
      return;
    }
    if (sec.deletion || newP === null) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(newP, applyHunks(before, sec.hunks, strict, oldP));
      tree.now.set(oldP, null);
      recordedMoves.push([oldP, newP]);
      return;
    }
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(before, sec.hunks, strict, oldP));
  });
}

// Section 7: SEARCH/REPLACE blocks. Throws Exit2 on a parse fault.
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let scanFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (trimEndWs(lines[i]!) !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i + 1;
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (trimEndWs(lines[j]!) === '=======') { sep = j; break; }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (trimEndWs(lines[j]!) === '>>>>>>> REPLACE') { end = j; break; }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let j = i - 1; j >= scanFrom; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile('\n', newLines, newLines.length > 0));
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const cur = splitFile(before);
      const occ = findOccurrence(cur.lines, oldLines, strict);
      if (occ === null) throw new Fail('no-match', p);
      if (occ.positions.length > 1) throw new Fail('ambiguous', p);
      tree.now.set(p, joinFile(cur.br, applyReplacement(cur.lines, oldLines, newLines, occ.positions[0]!, occ.tier, []), cur.final));
    });
    prevPath = path;
    scanFrom = end + 1;
    i = end + 1;
  }
  return edits;
}

// Section 8: V4A patches. Throws Exit2 on a parse fault.
type V4aChunk = { anchor: string | null; body: string[]; eof: boolean };

// The first occurrence of O at or after `from`, at the first tier with one
// (only tier 0 when strict); an end-of-file search takes only an occurrence
// ending at the file's last line.
function findAtOrAfter(fileLines: string[], O: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i + O.length <= fileLines.length; i++) {
      if (eof && i + O.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!eqAt(tier, fileLines[i + j]!, O[j]!)) { ok = false; break; }
      }
      if (ok) return { tier, pos: i };
    }
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  type RawLine = { text: string; no: number };
  type RawSection = { kind: 'add' | 'delete' | 'update'; path: string; line: number; raw: RawLine[] };
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  const close = (): void => {
    if (cur === null) return;
    while (cur.raw.length > 0 && blank(cur.raw[cur.raw.length - 1]!.text)) cur.raw.pop();
    sections.push(cur);
    cur = null;
  };
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) { close(); cur = { kind: 'add', path: line.slice(14).trim(), line: i + 1, raw: [] }; continue; }
    if (line.startsWith('*** Delete File: ')) { close(); cur = { kind: 'delete', path: line.slice(17).trim(), line: i + 1, raw: [] }; continue; }
    if (line.startsWith('*** Update File: ')) { close(); cur = { kind: 'update', path: line.slice(17).trim(), line: i + 1, raw: [] }; continue; }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.raw.push({ text: line, no: i + 1 });
  }
  close();

  const edits: Edit[] = [];
  for (const sec of sections) {
    if (sec.kind === 'add') {
      const content: string[] = [];
      for (const r of sec.raw) {
        if (r.text === '') content.push('');
        else if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      const p = sec.path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile('\n', content, content.length > 0));
      });
      continue;
    }
    if (sec.kind === 'delete') {
      for (const r of sec.raw) throw new Exit2(`error: parse ${r.no}`);
      const p = sec.path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    let moveTo: string | null = null;
    let idx = 0;
    if (sec.raw.length > 0 && sec.raw[0]!.text.startsWith('*** Move to: ')) {
      moveTo = sec.raw[0]!.text.slice(13).trim();
      idx = 1;
    }
    const chunks: V4aChunk[] = [];
    let open: { anchor: string | null; body: string[]; eof: boolean } | null = null;
    const closeOpen = (): void => {
      if (open !== null) { chunks.push({ anchor: open.anchor, body: open.body, eof: open.eof }); open = null; }
    };
    for (; idx < sec.raw.length; idx++) {
      const r = sec.raw[idx]!;
      const text = r.text;
      if (text === '*** End of File') {
        if (open !== null) { open.eof = true; closeOpen(); }
        else chunks.push({ anchor: null, body: [], eof: true });
        continue;
      }
      if (text.startsWith('@@')) {
        closeOpen();
        const a = text.slice(2).trim();
        open = { anchor: a === '' ? null : a, body: [], eof: false };
        continue;
      }
      if (text.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${r.no}`);
      if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
        if (open === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
          open = { anchor: null, body: [], eof: false };
        }
        open.body.push(text);
        continue;
      }
      throw new Exit2(`error: parse ${r.no}`);
    }
    closeOpen();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
    const p = sec.path;
    const mv = moveTo;
    const chs = chunks;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
      let cur = splitFile(before);
      let cursor = 0;
      for (const chunk of chs) {
        if (chunk.anchor !== null) {
          const a = findAtOrAfter(cur.lines, [chunk.anchor], cursor, strict, false);
          if (a === null) throw new Fail('no-match', p);
          cursor = a.pos + 1;
        }
        const O: string[] = [];
        const N: string[] = [];
        const ctx: [number, number][] = [];
        for (const b of chunk.body) {
          if (b === '' || b.startsWith(' ')) { O.push(b.slice(1)); N.push(b.slice(1)); ctx.push([O.length - 1, N.length - 1]); }
          else if (b.startsWith('-')) O.push(b.slice(1));
          else if (b.startsWith('+')) N.push(b.slice(1));
        }
        if (O.length === 0) {
          const at = chunk.eof ? cur.lines.length : cursor;
          cur = { br: cur.br, lines: [...cur.lines.slice(0, at), ...N, ...cur.lines.slice(at)], final: cur.final };
          cursor = at + N.length;
        } else {
          const occ = findAtOrAfter(cur.lines, O, cursor, strict, chunk.eof);
          if (occ === null) throw new Fail('no-match', p);
          cur = { br: cur.br, lines: applyReplacement(cur.lines, O, N, occ.pos, occ.tier, ctx), final: cur.final };
          cursor = occ.pos + N.length;
        }
      }
      const out = joinFile(cur.br, cur.lines, cur.final);
      if (mv !== null) {
        tree.now.set(mv, out);
        tree.now.set(p, null);
        recordedMoves.push([p, mv]);
      } else {
        tree.now.set(p, out);
      }
    });
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : kind === 'v4a' ? v4aEdits(lines, strict) : [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  recordedMoves.length = 0;
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = recordedMoves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      recordedMoves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  type Row = { key: string; text: string };
  const rowObjs: Row[] = [];
  const removed = new Set<string>();
  for (const [oldP, newP] of recordedMoves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null && changed.has(oldP) && changed.has(newP)) {
      removed.add(oldP);
      removed.add(newP);
      rowObjs.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  for (const [p, { was, now }] of changed) {
    if (removed.has(p)) continue;
    rowObjs.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowObjs.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowObjs.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
