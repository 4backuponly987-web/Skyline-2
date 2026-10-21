// Input: keyboard, mouse and gamepad, fully rebindable, with a contextual
// hint system instead of a permanent controls strip.
//
// Actions are named; bindings map physical keys/buttons to actions. Everything
// the game reads goes through `state` (held) and `pressed`/`released` (edge).

export const ACTIONS = {
  pitchUp: { label: 'Pull up / flare', group: 'Flight' },
  pitchDown: { label: 'Dive', group: 'Flight' },
  rollLeft: { label: 'Bank left', group: 'Flight' },
  rollRight: { label: 'Bank right', group: 'Flight' },
  yawLeft: { label: 'Yaw left', group: 'Flight' },
  yawRight: { label: 'Yaw right', group: 'Flight' },
  tuck: { label: 'Fold wings (dive)', group: 'Flight' },
  track: { label: 'Tracking pose', group: 'Flight' },
  flareSnap: { label: 'Jump / flare snap', group: 'Flight' },
  deploy: { label: 'Spread arms / deploy wings', group: 'Flight' },
  spawnPoint: { label: 'Respawn point (hold set / tap go)', group: 'World' },
  rollTrickL: { label: 'Barrel roll left', group: 'Tricks' },
  rollTrickR: { label: 'Barrel roll right', group: 'Tricks' },
  hard: { label: 'Hard manoeuvre (hold)', group: 'Flight' },
  flipMod: { label: 'Flip modifier', group: 'Tricks' },
  frontFlip: { label: 'Front flip', group: 'Tricks' },
  backFlip: { label: 'Back flip', group: 'Tricks' },
  heliMod: { label: 'Helicopter modifier', group: 'Tricks' },
  corkscrew: { label: 'Corkscrew', group: 'Tricks' },
  invert: { label: 'Toggle inverted', group: 'Tricks' },
  canopy: { label: 'Deploy parachute', group: 'Flight' },
  camera: { label: 'Camera mode', group: 'View' },
  setSpawn: { label: 'Set respawn point', group: 'World' },
  map: { label: 'World map', group: 'World' },
  respawn: { label: 'Respawn', group: 'World' },
  cycleSpawn: { label: 'Next respawn point', group: 'World' },
  teleport: { label: 'Teleport to selection', group: 'World' },
  photo: { label: 'Photo mode', group: 'View' },
  pause: { label: 'Pause / menu', group: 'System' },
  retry: { label: 'Restart the run', group: 'World' },
  scout: { label: 'Scout drone', group: 'World' },
  hud: { label: 'Toggle HUD', group: 'View' },
  bank: { label: 'Bank the run', group: 'World' },
};

export const DEFAULT_BINDS = {
  pitchUp: ['KeyS'],
  pitchDown: ['KeyW'],
  rollLeft: ['KeyA'],
  rollRight: ['KeyD'],
  yawLeft: ['ArrowLeft'],
  yawRight: ['ArrowRight'],
  tuck: ['ShiftLeft', 'ShiftRight'],
  track: ['ControlLeft', 'ControlRight'],
  flareSnap: ['Space'],
  deploy: ['KeyH'],
  spawnPoint: ['KeyJ'],
  rollTrickL: ['KeyQ'],
  rollTrickR: ['KeyE'],
  hard: ['Mouse0'],
  flipMod: ['KeyX'],
  heliMod: ['KeyZ', 'Mouse2'],
  corkscrew: ['KeyO'],
  frontFlip: ['KeyR'],
  backFlip: ['KeyF'],
  invert: ['KeyV'],
  canopy: ['KeyG'],
  camera: ['KeyC'],
  setSpawn: ['KeyB'],
  map: ['KeyM'],
  respawn: ['KeyI'],
  cycleSpawn: ['KeyN'],
  teleport: ['KeyT'],
  photo: ['KeyP'],
  pause: ['Tab'],
  retry: ['KeyL', 'KeyY'],
  scout: ['KeyK'],
  hud: ['KeyU'],
  bank: ['Enter'],
};

// Gamepad: standard mapping indices
const PAD_BUTTONS = {
  tuck: 6,        // LT
  track: 7,       // RT
  flareSnap: 0,   // A
  deploy: 3,      // Y
  rollTrickL: 4,  // LB
  rollTrickR: 5,  // RB
  flipMod: 2,     // X
  heliMod: 1,     // B
  corkscrew: 10,  // right stick click
  canopy: 9,
  camera: 8,
  pause: 9,
};

export class Input {
  constructor(target = window) {
    this.binds = JSON.parse(JSON.stringify(DEFAULT_BINDS));
    this.keyToActions = new Map();
    this.rebuild();

    this.down = new Set();
    this.state = {};
    this.pressed = {};
    this.released = {};
    this.mouse = { dx: 0, dy: 0, locked: false, sensitivity: 0.0022, invertY: false };
    this.useMouse = true;
    this.enabled = true;
    this.capture = null;   // when rebinding
    this.padIndex = null;
    this.padDeadzone = 0.16;
    this.lastDevice = 'keyboard';
    this._prevPad = [];

    for (const a in ACTIONS) {
      this.state[a] = false;
      this.pressed[a] = false;
      this.released[a] = false;
    }

    this._onKeyDown = (e) => {
      if (e.code === 'Tab') e.preventDefault();
      if (this.capture) {
        this.capture(e.code);
        this.capture = null;
        e.preventDefault();
        return;
      }
      if (!this.enabled) return;
      if (e.repeat) return;
      this.down.add(e.code);
      this.lastDevice = 'keyboard';
      const acts = this.keyToActions.get(e.code);
      if (acts) for (const a of acts) this.pressed[a] = true;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    };
    this._onKeyUp = (e) => {
      this.down.delete(e.code);
      const acts = this.keyToActions.get(e.code);
      if (acts) for (const a of acts) this.released[a] = true;
    };
    // Mouse buttons are just keys called Mouse0/Mouse1/Mouse2, so they go
    // through the same bind table as everything else and can be rebound.
    this._onMouseDown = (e) => {
      if (!this.enabled) return;
      const code = 'Mouse' + e.button;
      if (this.capture) { this.capture(code); this.capture = null; return; }
      this.down.add(code);
      const acts = this.keyToActions.get(code);
      if (acts) for (const a of acts) this.pressed[a] = true;
    };
    this._onMouseUp = (e) => {
      const code = 'Mouse' + e.button;
      this.down.delete(code);
      const acts = this.keyToActions.get(code);
      if (acts) for (const a of acts) this.released[a] = true;
    };
    this._onContextMenu = (e) => { e.preventDefault(); };
    this._onMouseMove = (e) => {
      if (!this.mouse.locked) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
      this.lastDevice = 'keyboard';
    };
    this._onBlur = () => {
      this.down.clear();
      for (const a in ACTIONS) this.state[a] = false;
    };
    this._onLockChange = () => {
      this.mouse.locked = !!document.pointerLockElement;
    };

    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('mousemove', this._onMouseMove);
    target.addEventListener('mousedown', this._onMouseDown);
    target.addEventListener('mouseup', this._onMouseUp);
    target.addEventListener('contextmenu', this._onContextMenu);
    target.addEventListener('blur', this._onBlur);
    document.addEventListener('pointerlockchange', this._onLockChange);
    window.addEventListener('gamepadconnected', (e) => { this.padIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.padIndex = null; });
  }

  rebuild() {
    this.keyToActions.clear();
    for (const action in this.binds) {
      for (const key of this.binds[action]) {
        if (!this.keyToActions.has(key)) this.keyToActions.set(key, []);
        this.keyToActions.get(key).push(action);
      }
    }
  }

  setBind(action, index, code) {
    this.binds[action] = this.binds[action] || [];
    this.binds[action][index] = code;
    this.rebuild();
  }

  resetBinds() {
    this.binds = JSON.parse(JSON.stringify(DEFAULT_BINDS));
    this.rebuild();
  }

  /** Call once per frame, before reading. */
  poll() {
    for (const a in ACTIONS) {
      let held = false;
      const keys = this.binds[a];
      if (keys) for (const k of keys) if (this.down.has(k)) { held = true; break; }
      this.state[a] = held;
    }

    // gamepad
    this.pad = null;
    if (navigator.getGamepads) {
      const pads = navigator.getGamepads();
      const pad = this.padIndex !== null ? pads[this.padIndex] : (pads[0] || null);
      if (pad && pad.connected) {
        this.pad = pad;
        const dz = this.padDeadzone;
        const ax = (i) => {
          const v = pad.axes[i] || 0;
          return Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz);
        };
        this.padAxes = { lx: ax(0), ly: ax(1), rx: ax(2), ry: ax(3) };
        if (Math.abs(this.padAxes.lx) + Math.abs(this.padAxes.ly) > 0.1) this.lastDevice = 'gamepad';
        for (const a in PAD_BUTTONS) {
          const b = pad.buttons[PAD_BUTTONS[a]];
          if (!b) continue;
          const now = b.pressed || b.value > 0.4;
          if (now) { this.state[a] = true; this.lastDevice = 'gamepad'; }
          if (now && !this._prevPad[PAD_BUTTONS[a]]) this.pressed[a] = true;
          if (!now && this._prevPad[PAD_BUTTONS[a]]) this.released[a] = true;
        }
        this._prevPad = pad.buttons.map((b) => b.pressed || b.value > 0.4);
      } else {
        this.padAxes = null;
      }
    }
  }

  /** Call at the end of the frame. */
  endFrame() {
    for (const a in ACTIONS) {
      this.pressed[a] = false;
      this.released[a] = false;
    }
    this.mouse.dx = 0;
    this.mouse.dy = 0;
  }

  axis(neg, pos) {
    return (this.state[pos] ? 1 : 0) - (this.state[neg] ? 1 : 0);
  }

  requestLock(el) {
    if (document.pointerLockElement) return;
    try {
      const r = el.requestPointerLock?.();
      if (r && r.catch) r.catch(() => {});
    } catch (e) { /* embedded contexts may refuse pointer lock */ }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  dispose(target = window) {
    target.removeEventListener('keydown', this._onKeyDown);
    target.removeEventListener('keyup', this._onKeyUp);
    target.removeEventListener('mousemove', this._onMouseMove);
    target.removeEventListener('blur', this._onBlur);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}

export function keyLabel(code) {
  if (!code) return '—';
  return code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace('ShiftLeft', 'Shift').replace('ShiftRight', 'R-Shift')
    .replace('ControlLeft', 'Ctrl').replace('ControlRight', 'R-Ctrl')
    .replace('ArrowLeft', '←').replace('ArrowRight', '→')
    .replace('ArrowUp', '↑').replace('ArrowDown', '↓');
}
