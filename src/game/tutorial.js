// Learn to fly.
//
// A sequence of steps, each one a thing to do and a test for whether you
// did it. Nothing is on a timer and nothing can be failed: a step stays up
// until you complete it, because the point is to teach the suit, not to
// examine you on it. Steps that need height put you back in the air if you
// have run out of it.
//
// The order is the order you need things in: get off the hill, get the wing
// working, point it where you want, go fast, go slow, go near something,
// and put it down.

export const STEPS = [
  {
    id: 'walk',
    title: 'Walk to the edge',
    body: 'You start on your feet on a rim. <kbd>W</kbd> walks, <kbd>A</kbd> and <kbd>D</kbd> turn, '
      + '<kbd>Shift</kbd> runs. The arrow at the bottom of the screen points at the drop.',
    hint: 'Walk off the lip.',
    done: (s) => s.state === 'flying' || s.state === 'tumble',
  },
  {
    id: 'glide',
    title: 'Fly it',
    body: 'You left the rim with the wing already spread, so you are flying. '
      + 'Let the speed build and watch the glide ratio bottom right climb towards 2.5:1 — '
      + 'that is two and a half metres forward for every metre down.',
    hint: 'Hold it straight until the glide settles above 2.0.',
    done: (s) => s.glide > 2.0 && s.speed > 28,
  },
  {
    id: 'turn',
    title: 'Turn',
    body: '<kbd>A</kbd> and <kbd>D</kbd> bank. Hold one and the suit settles into a turn and stays '
      + 'there; let go and it comes level on its own. The suit turns by banking, so a turn always '
      + 'costs you a little height.',
    hint: 'Change your heading by 90 degrees.',
    done: (s) => s.turned > Math.PI * 0.5,
  },
  {
    id: 'fast',
    title: 'Go fast',
    body: '<kbd>W</kbd> puts the nose down and <kbd>Shift</kbd> folds the wing away for a near '
      + 'vertical dive. Speed is height you have already spent, so spend it low over something.',
    hint: 'Get above 120 mph.',
    done: (s) => s.speed > 53.6,
  },
  {
    id: 'slow',
    title: 'Pull up',
    body: '<kbd>S</kbd> raises the nose and trades speed back for height. The suit will not let '
      + 'you stall by pulling up alone — only the flare can do that — so you can pull as hard as '
      + 'you like.',
    hint: 'Get the vertical speed above -8 m/s.',
    done: (s) => s.vario > -8,
  },
  {
    id: 'hard',
    title: 'The hard turn',
    body: 'Hold the <b>left mouse button</b> with <kbd>A</kbd> or <kbd>D</kbd> and the suit banks '
      + 'past ninety degrees and pulls at the same time — about two and a half times the turn '
      + 'rate. With <kbd>S</kbd> it is a hard pull-up instead. It runs out after about a second '
      + 'and comes back when you let go.',
    hint: 'Hold the left button and turn.',
    done: (s) => s.hardUsed,
  },
  {
    id: 'close',
    title: 'Get close',
    body: 'The whole game is here. The bar at the bottom fills as you fly near rock, and it '
      + 'multiplies everything you score. The number beside it is how close you actually are.',
    hint: 'Pass within 20 m of something.',
    done: (s) => s.closest < 20,
  },
  {
    id: 'trick',
    title: 'Throw something',
    body: '<kbd>Q</kbd> and <kbd>E</kbd> are barrel rolls — one per tap, hold through the end of '
      + 'one to keep rolling. <kbd>R</kbd> and <kbd>F</kbd> are front and back flips. '
      + 'A tap of <kbd>Space</kbd> rolls you inverted.',
    hint: 'Land any trick.',
    done: (s) => s.tricks > 0,
  },
  {
    id: 'land',
    title: 'Put it down',
    body: 'Arrive under 36 mph on ground you could stand on and you land on your feet. '
      + 'Hold <kbd>Space</kbd> to flare — that is the one input that will stall you, and it is '
      + 'how you kill the last of your speed. <kbd>G</kbd> throws the parachute if it goes wrong, '
      + 'and under canopy you can put down almost anywhere.',
    hint: 'Land on your feet, or under canopy.',
    done: (s) => s.state === 'ground',
  },
];

/**
 * Tracks which step you are on and what you have done. The game feeds it a
 * snapshot each frame; it owns nothing else.
 */
export class Tutorial {
  constructor() {
    this.reset();
  }

  reset() {
    this.active = false;
    this.index = 0;
    this.turned = 0;
    this.hardUsed = false;
    this.lastHeading = null;
    this.justAdvanced = false;
  }

  start() {
    this.reset();
    this.active = true;
    this.justAdvanced = true;
  }

  get step() {
    return this.active ? STEPS[this.index] : null;
  }

  get complete() {
    return this.active && this.index >= STEPS.length;
  }

  /**
   * @param {number} dt
   * @param {object} s {state, speed, glide, vario, closest, tricks, heading,
   *                    hard}
   * @returns {object|null} the step just completed, if any
   */
  update(dt, s) {
    if (!this.active || this.index >= STEPS.length) return null;

    // heading change accumulates for the turn step and resets after it
    if (this.lastHeading !== null && s.heading !== undefined) {
      let d = s.heading - this.lastHeading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.turned += Math.abs(d);
    }
    if (s.heading !== undefined) this.lastHeading = s.heading;
    if (s.hard) this.hardUsed = true;

    const step = STEPS[this.index];
    const view = Object.assign({}, s, {
      turned: this.turned,
      hardUsed: this.hardUsed,
    });
    // the first step is the only one you can be on the ground for
    if (this.index > 0 && s.state === 'ground' && step.id !== 'land') return null;

    if (step.done(view)) {
      this.index++;
      this.turned = 0;
      this.justAdvanced = true;
      return step;
    }
    return null;
  }
}
