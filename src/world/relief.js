// How tall the range is.
//
// Every authored height in the world -- ridge summits, lake levels, the
// mesa, the slot canyon floor, the tree and snow lines -- was written at an
// older, flatter scale where the mountains topped out at 3.1 km and most of
// the flyable ground sat inside a single kilometre band. That gave about
// forty seconds of glide and nothing to aim at.
//
// `lift` stretches everything above the valley floor. At 1.66 the summits
// stand near 4.6 km, a launch is 3.5 to 4.5 km up, and there is close to
// four vertical kilometres underneath it. Keeping it in its own module
// means both the field and the ridge network can use it without importing
// each other.

export const RELIEF = { floor: 620, scale: 1.66 };

export const lift = (h) => RELIEF.floor + (h - RELIEF.floor) * RELIEF.scale;
