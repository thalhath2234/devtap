'use strict';
// Finds what is listening on local TCP ports, which process owns it, and where
// that process sends its output (terminal, file, journald, docker).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function run(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}

function which(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

function ptraceScope() {
  try { return Number(fs.readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim()); } catch { return 0; }
}

// ---------------------------------------------------------------- processes

function procInfo(pid) {
  const read = (f) => { try { return fs.readFileSync(`/proc/${pid}/${f}`, 'utf8'); } catch { return null; } };
  const link = (f) => { try { return fs.readlinkSync(`/proc/${pid}/${f}`); } catch { return null; } };
  const comm = read('comm');
  if (comm == null) return null;
  const stat = read('stat') || '';
  const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || null;
  return {
    pid, ppid,
    name: comm.trim(),
    cmd: (read('cmdline') || '').split('\0').filter(Boolean).join(' '),
    cwd: link('cwd'),
    stdout: link('fd/1'),
    stderr: link('fd/2'),
    cgroup: read('cgroup') || '',
  };
}

function hexToIp(hex) {
  if (hex.length === 8) return hex.match(/../g).reverse().map((b) => parseInt(b, 16)).join('.');
  if (/^0+$/.test(hex)) return '::';
  if (hex === '00000000000000000000000001000000') return '::1';
  if (hex.startsWith('0000000000000000FFFF0000')) return hexToIp(hex.slice(24));
  return 'ipv6';
}

function linuxListeners() {
  const socks = new Map(); // inode -> { port, address }
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== '0A') continue; // 0A = LISTEN
      const [addr, port] = f[1].split(':');
      socks.set(f[9], { port: parseInt(port, 16), address: hexToIp(addr) });
    }
  }
  const byPort = new Map();
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; } // other users' processes
    for (const fd of fds) {
      let l;
      try { l = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(l);
      const s = m && socks.get(m[1]);
      if (s && !byPort.has(s.port)) byPort.set(s.port, { port: s.port, address: s.address, ...procInfo(Number(pid)) });
    }
  }
  // Ports held by processes we can't inspect (root, docker-proxy): port known, owner not.
  for (const s of socks.values()) if (!byPort.has(s.port)) byPort.set(s.port, { port: s.port, address: s.address, pid: null });
  return [...byPort.values()];
}

function lsofListeners() {
  const out = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']);
  if (!out) return [];
  const byPort = new Map();
  let pid = null, name = null;
  for (const line of out.split('\n')) {
    const k = line[0], v = line.slice(1);
    if (k === 'p') pid = Number(v);
    else if (k === 'c') name = v;
    else if (k === 'n') {
      const port = Number(v.slice(v.lastIndexOf(':') + 1));
      if (port && !byPort.has(port)) {
        const outs = run('lsof', ['-p', String(pid), '-a', '-d', '1,2', '-F', 'fn']) || '';
        const files = outs.split('\n').filter((l) => l[0] === 'n').map((l) => l.slice(1));
        byPort.set(port, { port, address: v.slice(0, v.lastIndexOf(':')), pid, name, cmd: name, stdout: files[0] || null, stderr: files[1] || null, cgroup: '' });
      }
    }
  }
  return [...byPort.values()];
}

function listeners() {
  const list = fs.existsSync('/proc/net/tcp') ? linuxListeners() : lsofListeners();
  return list.sort((a, b) => a.port - b.port);
}

// ---------------------------------------------------------------- where output goes

function classifyOutput(link) {
  if (!link) return { type: 'unknown' };
  if (/^\/dev\/(pts\/|tty)/.test(link)) return { type: 'terminal', path: link };
  if (link === '/dev/null') return { type: 'null' };
  if (link.startsWith('pipe:')) return { type: 'pipe' };
  if (link.startsWith('socket:')) return { type: 'socket' };
  const file = link.replace(/ \(deleted\)$/, '');
  if (file.startsWith('/') && !link.endsWith('(deleted)')) {
    try { if (fs.statSync(file).isFile()) return { type: 'file', path: file }; } catch {}
  }
  return { type: 'other', path: link };
}

// systemd puts each service in its own cgroup; journald receives its output via a socket.
function systemdUnit(info) {
  const m = /\/([^/\n]+\.service)\s*$/m.exec(info.cgroup || '');
  if (!m) return null;
  const toJournal = [info.stdout, info.stderr].some((l) => classifyOutput(l).type === 'socket');
  if (!toJournal) return null;
  return { name: m[1], user: /\/user@\d+\.service\//.test(info.cgroup) };
}

function dockerContainers() {
  if (!which('docker')) return [];
  const out = run('docker', ['ps', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}']);
  if (!out) return [];
  return out.trim().split('\n').filter(Boolean).map((l) => {
    const [id, name, image, ports = ''] = l.split('\t');
    const published = [...ports.matchAll(/:(\d+)->(\d+)\/tcp/g)].map((m) => ({ host: Number(m[1]), container: Number(m[2]) }));
    return { id, name, image, published };
  });
}

// Decide where the logs of whatever serves `port` can be read from.
function logSourceFor(port) {
  const container = dockerContainers().find((c) => c.published.some((p) => p.host === port));
  if (container) return { kind: 'docker', container };
  const l = listeners().find((x) => x.port === port);
  if (!l) return { kind: 'nothing' };
  if (!l.pid) return { kind: 'foreign' };
  const unit = systemdUnit(l);
  if (unit) return { kind: 'journal', unit, proc: l };
  const outs = [classifyOutput(l.stdout), classifyOutput(l.stderr)];
  const files = [...new Set(outs.filter((o) => o.type === 'file').map((o) => o.path))];
  const parent = l.ppid ? procInfo(l.ppid) : null;
  const launcher = parent && ['go', 'air', 'nodemon', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'reflex', 'gow'].includes(parent.name) ? parent : null;
  if (files.length) return { kind: 'files', files, proc: l, launcher };
  return { kind: 'unreadable', outs, proc: l, launcher };
}

// ---------------------------------------------------------------- strace output → bytes

const C_ESCAPES = { n: 10, t: 9, r: 13, v: 11, f: 12, a: 7, b: 8, '\\': 92, '"': 34, "'": 39 };

function unescapeC(s, out) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out.push(s.charCodeAt(i) & 255); continue; }
    const n = s[++i];
    if (n in C_ESCAPES) out.push(C_ESCAPES[n]);
    else if (n === 'x') { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else if (n >= '0' && n <= '7') {
      let j = i, oct = '';
      while (j < s.length && oct.length < 3 && s[j] >= '0' && s[j] <= '7') oct += s[j++];
      out.push(parseInt(oct, 8) & 255);
      i = j - 1;
    } else if (n !== undefined) out.push(n.charCodeAt(0) & 255);
  }
  return out;
}

// `[pid 123] write(2, "hello\n", 6) = 6` → { fd: 2, data: <Buffer hello\n> }
function parseStraceLine(line) {
  const m = /^(?:\[pid\s+\d+\]\s+|\d+\s+)?writev?\(([12]), (.*)$/.exec(line);
  if (!m) return null;
  const bytes = [];
  for (const s of m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)) unescapeC(s[1], bytes);
  return bytes.length ? { fd: Number(m[1]), data: Buffer.from(bytes) } : null;
}

module.exports = { which, ptraceScope, procInfo, listeners, classifyOutput, dockerContainers, logSourceFor, parseStraceLine };
