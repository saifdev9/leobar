/* Runs after every widget file has registered. One-time moves to newer defaults, oldest first. */
store.order = store.order.filter((id) => W[id]);
if (!store.v2) { store.theme = 'glass'; store.v2 = true; } // the glass look
if (!store.v3) { store.size = 'm'; store.span = 'full'; store.v3 = true; } // the bigger, full-width bar
if (!store.v4) { store.effect = 'liquid'; store.frost = 'clear'; store.align = 'center'; store.v4 = true; } // wallpaper liquid glass
if (!store.v5) { store.effect = 'live'; store.v5 = true; } // Live GPU glass
// The Windows window effects (Frosted, Blur, Mica) are gone: the dock window is now a tall
// transparent canvas, and Live glass with Clarity covers those looks.
if (['acrylic', 'blur', 'mica', 'none'].includes(store.effect)) store.effect = 'live';
save();
boot();
