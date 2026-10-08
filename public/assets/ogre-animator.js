// ogre-animator.js - classic-script WAAPI animation runtime for Ogre rigs.
(function () {
  'use strict';

  var EASING = {
    linear: 'linear',
    ease: 'ease',
    easeIn: 'ease-in',
    easeOut: 'ease-out',
    easeInOut: 'ease-in-out'
  };

  var PRIORITY = { microlife: 1, face: 2, oneshot: 3, body: 3, pose: 3, scrub: 3 };
  var DEFAULT_BLEND_MS = 150; // used when the spec's meta.blendMs is absent (spec 0.4.0)
  // Spec 0.5.0 (face_parity_brainstorm.md section 13): the shared schedule,
  // mood bands, reactions and blink.
  var DEFAULT_EPOCH_MS = 300000; // schedule.epochMs when the spec has no schedule section
  var DEFAULT_HOLD_MS = [4000, 6000]; // a pool state without face.holdMs, when the spec's schedule.defaultHoldMs is absent too (the spec pins it so every player agrees)
  var DEFAULT_BAND = 'calm'; // 13.2: no mood known -> calm
  var DEFAULT_KEY = 'owner'; // 13.3: Ogrebuddy and Ogrebite are the owner's windows
  var MOOD_AXES = ['energy', 'valence', 'bond', 'attention'];
  var MOOD_NAME = /^[a-z_]+$/;
  var REACTION_GROUP = 'reaction';
  var BLINK_CLIP = 'face-blink';
  var MAX_SCHEDULE_ENTRIES = 100000; // never hang on a degenerate spec (zero holds); a sane spec stops at the epoch end long before

  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj || {}, key); }
  function asArray(value) { return Array.isArray(value) ? value : []; }
  function clipExists(spec, name) { return !!(name && spec && spec.clips && spec.clips[name]); }
  function playableExists(spec, name) {
    return !!(name && spec && ((spec.clips && spec.clips[name]) || (spec.sequences && spec.sequences[name]) || (spec.oneshots && spec.oneshots[name])));
  }
  function easingToCss(easing) {
    if (!easing) return undefined;
    if (typeof easing === 'string') return EASING[easing] || easing;
    if (Array.isArray(easing) && easing.length === 4) return 'cubic-bezier(' + easing.join(',') + ')';
    if (isObject(easing) && easing.spring) return 'linear';
    return undefined;
  }
  function hasSpring(easing) { return !!(isObject(easing) && easing.spring); }
  function numberOr(value, fallback) { return typeof value === 'number' && isFinite(value) ? value : fallback; }
  function normalizeScale(kf) {
    var base = hasOwn(kf, 'scale') ? Number(kf.scale) : 1;
    return { x: hasOwn(kf, 'scaleX') ? Number(kf.scaleX) : base, y: hasOwn(kf, 'scaleY') ? Number(kf.scaleY) : base };
  }
  // A compiled track keeps two views of each keyframe: `frames` (the numeric
  // pose, in the artwork's units) and `keyframes` (the WAAPI keyframe built
  // from it). Root tracks are rebuilt from `frames` at play time with the body
  // element's scale (rootScale); face parts use `keyframes` as compiled.
  function frameValues(kf) {
    var scale = normalizeScale(kf);
    var out = { t: numberOr(kf.t, 0), x: numberOr(kf.x, 0), y: numberOr(kf.y, 0), rotate: numberOr(kf.rotate, 0), scaleX: scale.x, scaleY: scale.y };
    if (hasOwn(kf, 'opacity')) out.opacity = Number(kf.opacity);
    if (hasOwn(kf, 'visible')) out.visible = !!kf.visible;
    var easing = easingToCss(kf.easing);
    if (easing) out.easing = easing;
    return out;
  }
  function frameToKeyframe(values) {
    var out = { offset: values.t, transform: 'translate(' + values.x + 'px,' + values.y + 'px) rotate(' + values.rotate + 'deg) scale(' + values.scaleX + ',' + values.scaleY + ')' };
    if (hasOwn(values, 'opacity')) out.opacity = values.opacity;
    if (hasOwn(values, 'visible')) out.visibility = values.visible ? 'visible' : 'hidden';
    if (values.easing) out.easing = values.easing;
    return out;
  }
  function scaledKeyframes(frames, factor) {
    return frames.map(function (values) {
      var scaled = Object.assign({}, values);
      scaled.x = values.x * factor;
      scaled.y = values.y * factor;
      return frameToKeyframe(scaled);
    });
  }
  function readKfValue(kf, key) {
    if (key === 'scaleX') {
      if (hasOwn(kf, 'scaleX')) return Number(kf.scaleX);
      if (hasOwn(kf, 'scale')) return Number(kf.scale);
      return 1;
    }
    if (key === 'scaleY') {
      if (hasOwn(kf, 'scaleY')) return Number(kf.scaleY);
      if (hasOwn(kf, 'scale')) return Number(kf.scale);
      return 1;
    }
    if (key === 'opacity') return hasOwn(kf, 'opacity') ? Number(kf.opacity) : 1;
    if (key === 'rotate' || key === 'x' || key === 'y') return hasOwn(kf, key) ? Number(kf[key]) : 0;
    return kf[key];
  }
  function interpolateFrame(a, b, progress, offset) {
    var out = { t: offset };
    ['x', 'y', 'rotate', 'scaleX', 'scaleY', 'opacity'].forEach(function (key) {
      if (hasOwn(a, key) || hasOwn(b, key) || key === 'scaleX' || key === 'scaleY') {
        var av = readKfValue(a, key);
        var bv = readKfValue(b, key);
        out[key] = av + (bv - av) * progress;
      }
    });
    if (hasOwn(a, 'visible') || hasOwn(b, 'visible')) out.visible = progress >= 1 ? !!b.visible : !!a.visible;
    return out;
  }
  function bakeSpring(params) {
    params = params || {};
    var stiffness = Math.max(1, Number(params.stiffness) || 170);
    var damping = Math.max(0.001, Number(params.damping) || 26);
    var mass = Math.max(0.001, Number(params.mass) || 1);
    var velocity = Number(params.velocity) || 0;
    var w0 = Math.sqrt(stiffness / mass);
    var zeta = damping / (2 * Math.sqrt(stiffness * mass));
    var duration = Math.min(2000, Math.max(180, Math.ceil(7000 / Math.max(0.001, zeta * w0))));
    var samples = [];
    var last = 0;
    function response(seconds) {
      if (zeta < 1) {
        var wd = w0 * Math.sqrt(1 - zeta * zeta);
        var a = -1;
        var b = (velocity - zeta * w0) / wd;
        return 1 + Math.exp(-zeta * w0 * seconds) * (a * Math.cos(wd * seconds) + b * Math.sin(wd * seconds));
      }
      var decay = Math.exp(-w0 * seconds);
      return 1 - decay * (1 + w0 * seconds);
    }
    for (var i = 0; i < 48; i += 1) {
      var offset = i / 47;
      var value = response((duration / 1000) * offset);
      if (!isFinite(value)) value = offset;
      value = Math.max(last, Math.min(1, value));
      if (i === 47) value = 1;
      last = value;
      samples.push({ offset: offset, value: value, easing: 'linear' });
    }
    samples.duration = duration;
    return samples;
  }
  function expandSpringTrack(track) {
    var keyframes = asArray(track.keyframes).slice().sort(function (a, b) { return Number(a.t) - Number(b.t); });
    if (!keyframes.length) return keyframes;
    var trackSpring = hasSpring(track.easing) ? track.easing.spring : null;
    var expanded = [keyframes[0]];
    for (var i = 1; i < keyframes.length; i += 1) {
      var prev = keyframes[i - 1];
      var next = keyframes[i];
      var spring = trackSpring || (hasSpring(next.easing) ? next.easing.spring : null);
      if (!spring) { expanded.push(next); continue; }
      var baked = bakeSpring(spring);
      for (var j = 1; j < baked.length; j += 1) {
        var local = baked[j];
        expanded.push(interpolateFrame(prev, next, local.value, Number(prev.t) + (Number(next.t) - Number(prev.t)) * local.offset));
      }
    }
    return expanded;
  }
  function compileTrack(clip, track) {
    var springTrack = hasSpring(track.easing);
    var frames = expandSpringTrack(track).map(frameValues);
    return { part: track.part, frames: frames, keyframes: frames.map(frameToKeyframe), timing: { duration: clip.duration, delay: track.delay || 0, iterations: clip.loop === true ? Infinity : (clip.loop || 1), easing: springTrack ? 'linear' : (easingToCss(track.easing) || 'linear'), fill: 'both' }, meta: track.meta || null };
  }
  function getClipParts(compiledClip) {
    var seen = {};
    var parts = [];
    asArray(compiledClip.tracks).forEach(function (track) { if (!seen[track.part]) { seen[track.part] = true; parts.push(track.part); } });
    return parts;
  }

  // ---------------------------------------------------------------------------
  // The shared face schedule (spec 0.5.0, section 13.3) - the REFERENCE
  // IMPLEMENTATION every player (Ogrebite, the dashboard, MyOgre's FaceDirector,
  // the robot's state machine) reproduces bit for bit. Pure functions over the
  // spec (raw or compiled: they read states, pools, schedule and mood only);
  // exact uint32 arithmetic through Math.imul and >>> 0. Conformance fixture:
  // tools/schedule-golden.json (13.7), generated from these by
  // tools/test-animator.js and mirrored to the other players' tests.
  // ---------------------------------------------------------------------------
  // UTF-8 bytes of a string (lone surrogates become U+FFFD, as TextEncoder does).
  function utf8Bytes(str) {
    var out = [];
    str = String(str);
    for (var i = 0; i < str.length; i += 1) {
      var c = str.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        var d = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i += 1; }
        else c = 0xFFFD;
      } else if (c >= 0xDC00 && c <= 0xDFFF) c = 0xFFFD;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return out;
  }
  // FNV-1a 32: h = 2166136261; per byte: h ^= b; h = (h * 16777619) mod 2^32.
  function fnv1a32(str) {
    var bytes = utf8Bytes(str);
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i += 1) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
    return h >>> 0;
  }
  // mulberry32 on uint32 state; next() returns the raw uint32 (r = out / 2^32).
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
      t = (t ^ ((t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0)) >>> 0;
      return (t ^ (t >>> 14)) >>> 0;
    };
  }
  function unitInterval(u32) { return u32 / 4294967296; }
  function seedString(key, state, band, epochIndex) { return String(key) + '|' + String(state) + '|' + String(band) + '|' + String(epochIndex); }
  function epochMsOf(spec) { var schedule = (spec && spec.schedule) || {}; var value = numberOr(schedule.epochMs, DEFAULT_EPOCH_MS); return value > 0 ? value : DEFAULT_EPOCH_MS; }
  // The state's face.holdMs, else the spec's schedule.defaultHoldMs, else [4000, 6000].
  function holdRangeOf(spec, state) {
    var schedule = (spec && spec.schedule) || {};
    var range = state && state.face && Array.isArray(state.face.holdMs) ? state.face.holdMs : (Array.isArray(schedule.defaultHoldMs) ? schedule.defaultHoldMs : DEFAULT_HOLD_MS);
    var min = numberOr(Number(range[0]), 0);
    var max = numberOr(Number(range[1]), min);
    return { min: min, max: max < min ? min : max };
  }
  function poolItemsOf(spec, poolName) {
    var pool = spec && spec.pools ? spec.pools[poolName] : null;
    return { pool: pool || null, items: asArray(pool && pool.items).filter(function (item) { return isObject(item) && typeof item.ref === 'string' && item.ref; }) };
  }
  // x = floor(r1 * total); walk the items in listed order accumulating weights;
  // the first with x < cumulative is the pick.
  function weightedPick(items, weights, r1) {
    var total = 0;
    for (var i = 0; i < weights.length; i += 1) total += weights[i];
    if (!(total > 0)) return items[0];
    var x = Math.floor(r1 * total);
    var cumulative = 0;
    for (var j = 0; j < items.length; j += 1) { cumulative += weights[j]; if (x < cumulative) return items[j]; }
    return items[items.length - 1];
  }
  // The whole epoch's sequence [{clip, holdMs}] for a pool state: eligible items
  // (not among the last noRepeatWindow picks; all if that leaves none) in listed
  // order, weight x the band's multiplier (default 1), r1 picks, r2 holds
  // min + floor(r2 * (max - min + 1)), until the holds reach epochMs. The entry
  // that straddles the epoch end is included uncut (scheduleAt cuts it).
  function scheduleSequence(spec, args) {
    args = args || {};
    var state = spec && spec.states ? spec.states[args.state] : null;
    if (!state || !state.face || !state.face.pool) return [];
    var found = poolItemsOf(spec, state.face.pool);
    var items = found.items;
    if (!items.length) return [];
    var epochMs = epochMsOf(spec);
    var band = args.band === undefined || args.band === null ? DEFAULT_BAND : String(args.band);
    var key = args.key === undefined || args.key === null ? DEFAULT_KEY : String(args.key);
    var epochIndex = numberOr(args.epochIndex, 0);
    var multipliers = (spec.mood && isObject(spec.mood.weights) && isObject(spec.mood.weights[band])) ? spec.mood.weights[band] : {};
    var windowSize = Math.max(0, Math.floor(numberOr(found.pool.noRepeatWindow, 0)));
    var hold = holdRangeOf(spec, state);
    var next = mulberry32(fnv1a32(seedString(key, args.state, band, epochIndex)));
    var history = [];
    var t = 0;
    var out = [];
    while (out.length < MAX_SCHEDULE_ENTRIES) {
      var recent = windowSize > 0 ? history.slice(Math.max(0, history.length - windowSize)) : [];
      var eligible = items.filter(function (item) { return recent.indexOf(item.ref) === -1; });
      if (!eligible.length) eligible = items;
      var weights = eligible.map(function (item) {
        var weight = numberOr(item.weight, 1);
        var multiplier = multipliers[item.ref];
        return weight * (typeof multiplier === 'number' && isFinite(multiplier) ? multiplier : 1);
      });
      var r1 = unitInterval(next());
      var pick = weightedPick(eligible, weights, r1);
      var r2 = unitInterval(next());
      var holdMs = hold.min + Math.floor(r2 * (hold.max - hold.min + 1));
      out.push({ clip: pick.ref, holdMs: holdMs });
      history.push(pick.ref);
      t += holdMs;
      if (t >= epochMs) break;
    }
    return out;
  }
  // The entry covering nowMs (renderer wall clock, Unix ms): its clip, its
  // listed hold, where it starts and where it ends - cut at the epoch end, so a
  // renderer that re-picks at endsAtMs recomputes with the next epoch index by
  // itself. null for a state without a pool face (a fixed face.clip has no
  // sequence) or an empty pool.
  function scheduleAt(spec, args) {
    args = args || {};
    var epochMs = epochMsOf(spec);
    var nowMs = numberOr(args.nowMs, 0);
    var epochIndex = Math.floor(nowMs / epochMs);
    var entries = scheduleSequence(spec, { key: args.key, state: args.state, band: args.band, epochIndex: epochIndex });
    if (!entries.length) return null;
    var epochStart = epochIndex * epochMs;
    var offset = nowMs - epochStart;
    var start = 0;
    var index = -1;
    for (var i = 0; i < entries.length; i += 1) {
      if (offset < start + entries[i].holdMs) { index = i; break; }
      start += entries[i].holdMs;
    }
    var end;
    if (index === -1) { index = entries.length - 1; start -= entries[index].holdMs; end = epochMs; } // sequence shorter than the epoch (degenerate spec): hold to the epoch end
    else end = Math.min(start + entries[index].holdMs, epochMs);
    var entry = entries[index];
    return { clip: entry.clip, holdMs: entry.holdMs, startsAtMs: epochStart + start, endsAtMs: epochStart + end, epochIndex: epochIndex, index: index };
  }
  // The face clip a reaction row plays: its face, the payload's face for a
  // "payload" row, or a pick from its pool through the same PRNG seeded with
  // fnv1a32(key|reaction|name|nowMs), so a pool reaction is deterministic per
  // call and every window that reacts at the same ms picks the same clip.
  function reactionClip(spec, name, args) {
    args = args || {};
    var row = spec && spec.reactions ? spec.reactions[name] : null;
    if (!isObject(row)) return null;
    if (row.pool) {
      var items = poolItemsOf(spec, row.pool).items;
      if (!items.length) return null;
      var key = args.key === undefined || args.key === null ? DEFAULT_KEY : String(args.key);
      var next = mulberry32(fnv1a32(String(key) + '|reaction|' + String(name) + '|' + String(numberOr(args.nowMs, 0))));
      var weights = items.map(function (item) { return numberOr(item.weight, 1); });
      return weightedPick(items, weights, unitInterval(next())).ref;
    }
    if (row.face === 'payload') return isObject(args.payload) && typeof args.payload.face === 'string' ? args.payload.face : null;
    return typeof row.face === 'string' ? row.face : null;
  }
  // 13.2: the first band (in listed order) whose every `when` rule holds on the
  // mood vector (min inclusive, below exclusive; a missing axis fails the rule).
  function moodBandFor(spec, vector) {
    vector = isObject(vector) ? vector : {};
    var bands = asArray(spec && spec.mood && spec.mood.bands);
    for (var i = 0; i < bands.length; i += 1) {
      var band = bands[i];
      if (!isObject(band) || typeof band.name !== 'string') continue;
      var when = isObject(band.when) ? band.when : {};
      var ok = Object.keys(when).every(function (axis) {
        var rule = when[axis];
        if (!isObject(rule)) return true;
        var value = Number(vector[axis]);
        if (!isFinite(value)) return false;
        if (hasOwn(rule, 'min') && !(value >= Number(rule.min))) return false;
        if (hasOwn(rule, 'below') && !(value < Number(rule.below))) return false;
        return true;
      });
      if (ok) return band.name;
    }
    return DEFAULT_BAND;
  }
  // 13.1: friendly mood names live on the clips. moodNames lists them in clip
  // order (a body's face-tool enum is built from this list); clipForMood maps
  // a name back to its clip.
  function moodNames(spec) {
    var clips = (spec && spec.clips) || {};
    return Object.keys(clips).filter(function (name) { return clips[name] && typeof clips[name].mood === 'string'; }).map(function (name) { return clips[name].mood; });
  }
  function clipForMood(spec, mood) {
    var clips = (spec && spec.clips) || {};
    var names = Object.keys(clips);
    for (var i = 0; i < names.length; i += 1) if (clips[names[i]] && clips[names[i]].mood === mood) return names[i];
    return null;
  }

  // ---- Costumes and decorations (spec 0.6.0, section 14) ----
  // How a costume shows a clip, the same answer for every host and the gallery:
  //   { kind: 'all' }                     the rig plays every clip itself
  //   { kind: 'still' }                   the costume has its own art for the clip
  //   { kind: 'map', to: <clip> }         it shows another clip it answers
  //   { kind: 'glyphs', glyphs: {...} }   a glyph costume's set for the clip
  //   { kind: 'rest', gap: <bool> }       it shows rest: mapped there (gap false),
  //                                       or the clip is in neither list (gap true)
  // Every answer carries costume and clip; 'rest' carries the costume's rest
  // glyphs when it declares them. An unknown costume returns null.
  function costumeAnswer(spec, costume, clip) {
    var entry = spec && isObject(spec.costumes) ? spec.costumes[costume] : null;
    if (!isObject(entry)) return null;
    var answer = { kind: 'rest', costume: costume, clip: clip, gap: true };
    var mapped = isObject(entry.clipMap) && hasOwn(entry.clipMap, clip) ? entry.clipMap[clip] : undefined;
    if (entry.answers === 'all') { answer.kind = 'all'; answer.gap = false; }
    else if (asArray(entry.answers).indexOf(clip) !== -1) { answer.kind = 'still'; answer.gap = false; }
    else if (isObject(mapped)) { answer.kind = 'glyphs'; answer.glyphs = clone(mapped); answer.gap = false; }
    else if (typeof mapped === 'string' && mapped !== 'rest') { answer.kind = 'map'; answer.to = mapped; answer.gap = false; }
    else if (mapped === 'rest') answer.gap = false;
    if (answer.kind === 'rest' && isObject(entry.rest)) answer.glyphs = clone(entry.rest);
    return answer;
  }
  // Switches a decoration's art on or off in one copy of the rig: the `show`
  // ids are visible when on and hidden when off, the `hide` ids the reverse.
  // Scoped to svgRoot, because a page may hold several copies of the rig with
  // the same ids. Never throws; a missing id is skipped. Returns whether the
  // spec has the decoration.
  function decorate(svgRoot, spec, name, on) {
    var decoration = spec && isObject(spec.decorations) ? spec.decorations[name] : null;
    if (!isObject(decoration)) return false;
    if (!svgRoot || typeof svgRoot.querySelector !== 'function') return true;
    function setAll(ids, visible) {
      asArray(ids).forEach(function (id) {
        if (typeof id !== 'string' || !id) return;
        var el = null;
        try { el = svgRoot.querySelector('[id="' + attrEscape(id) + '"]'); } catch (err) { el = null; }
        if (el && typeof el.setAttribute === 'function') { try { el.setAttribute('visibility', visible ? 'visible' : 'hidden'); } catch (err2) {} }
      });
    }
    setAll(decoration.show, !!on);
    setAll(decoration.hide, !on);
    return true;
  }

  // ---- Gestures and energy (spec 0.7.0, section 15.2) ----
  // The vocabulary of a line's `gesture` and `energy`. A gesture is a semantic
  // move with no angles: a body with a head maps it to its own motion, and the
  // animator plays none (no browser face moves a head). gestureNames lists them
  // in spec order; energyLevel returns a copy of a level's entry
  // ({ level, name, everyMs, gestures }), or null for 0 and any unknown level.
  function gestureNames(spec) {
    return spec && isObject(spec.gestures) ? Object.keys(spec.gestures) : [];
  }
  function energyLevel(spec, level) {
    var entries = spec && Array.isArray(spec.energy) ? spec.energy : [];
    for (var i = 0; i < entries.length; i += 1) if (isObject(entries[i]) && entries[i].level === level) return clone(entries[i]);
    return null;
  }

  // ---- Eye tracking (spec 0.7.0) ----
  // The pupils follow the pointer, for any host and any number of faces on a
  // page: one document mousemove listener and one requestAnimationFrame loop
  // serve every tracked face. Each face is a copy of the rig under its own
  // svgRoot (the <svg> itself), and everything is looked up inside that root.
  // Tracking moves the INNER group of L-pupil / R-pupil (the outer group when
  // there is no inner one), so it composes with a face clip animating the outer
  // group, and art inside the inner group (the kawaii hearts) follows too.
  // Travel is in artwork units: the spec's eyeTracking.maxTravel, reached when
  // the pointer is eyeTracking.reachPx screen px from the eye. A pupil's home
  // is its dot's cx / cy in the art.
  // A face is at home, not tracking, while: no mousemove has arrived yet (so a
  // touch device never moves it); the root has no size (not displayed); motion
  // is reduced (the animator's own decision when one is given, else the media
  // query); or the given animator is playing a clip whose eyeTracking is false,
  // in any group, reactions included.
  //   var eyes = OgreAnimator.trackEyes(svgRoot, { spec: compiledSpec, animator: animator });
  //   eyes.stop();
  // Both options are optional. Call it right after constructing the animator:
  // it learns the playing clip from clipstart / clipend / statechange.
  var EYE_DEFAULTS = { maxTravel: 6, reachPx: 120, width: 469.83, height: 474.51, L: { cx: 127.77, cy: 252.38 }, R: { cx: 351.45, cy: 231.75 } };
  var eyeTrackers = [];
  var eyePointer = { x: 0, y: 0, seen: false };
  var eyeFrame = null;
  var eyeListening = false;
  var eyeMql = null;
  function eyeOnMove(evt) { eyePointer.x = evt.clientX; eyePointer.y = evt.clientY; eyePointer.seen = true; }
  function eyeQuery(root, selector) {
    try { return root.querySelector(selector) || null; } catch (err) { return null; }
  }
  function eyeBuild(root, side) {
    var el = eyeQuery(root, '[id="' + side + '-pupil"] > g') || eyeQuery(root, '[id="' + side + '-pupil"]');
    var dot = eyeQuery(root, '[id="' + side + '-pupil-dot"]');
    var cx = dot && typeof dot.getAttribute === 'function' ? parseFloat(dot.getAttribute('cx')) : NaN;
    var cy = dot && typeof dot.getAttribute === 'function' ? parseFloat(dot.getAttribute('cy')) : NaN;
    // x / y: the offset last written, in hundredths of an artwork unit.
    return { el: el && typeof el.setAttribute === 'function' ? el : null, cx: isFinite(cx) ? cx : EYE_DEFAULTS[side].cx, cy: isFinite(cy) ? cy : EYE_DEFAULTS[side].cy, x: 0, y: 0 };
  }
  function eyeSet(eye, dx, dy) {
    var x = Math.round(dx * 100), y = Math.round(dy * 100);
    if (!eye.el || (eye.x === x && eye.y === y)) return;
    eye.x = x; eye.y = y;
    try { eye.el.setAttribute('transform', 'translate(' + (x / 100).toFixed(2) + ' ' + (y / 100).toFixed(2) + ')'); } catch (err) {}
  }
  function eyeAim(tracker, eye, rect) {
    var dx = eyePointer.x - (rect.left + (eye.cx / tracker.width) * rect.width);
    var dy = eyePointer.y - (rect.top + (eye.cy / tracker.height) * rect.height);
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    var mag = Math.min(dist / tracker.reachPx, 1) * tracker.maxTravel;
    eyeSet(eye, (dx / dist) * mag, (dy / dist) * mag);
  }
  function eyeHome(tracker) { eyeSet(tracker.left, 0, 0); eyeSet(tracker.right, 0, 0); }
  // A clip that owns the pupils is recognised by the clip, whatever group it
  // plays in. The reaction group's slot only counts while a reaction is live:
  // a reaction ends by cancelling its group, which emits nothing.
  function eyeOwned(tracker) {
    var slots = tracker.slots, clips = tracker.clips;
    for (var group in slots) {
      var name = slots[group];
      if (name === null) continue;
      if (group === REACTION_GROUP && !tracker.animator.activeReaction) { slots[group] = null; continue; }
      if (clips[name] && clips[name].eyeTracking === false) return true;
    }
    return false;
  }
  function eyeUpdate(tracker) {
    var reduced = tracker.animator ? !!tracker.animator._reducedMotion : !!(eyeMql && eyeMql.matches);
    if (!eyePointer.seen || reduced || (tracker.animator && eyeOwned(tracker))) { eyeHome(tracker); return; }
    var rect = null;
    try { rect = tracker.root.getBoundingClientRect(); } catch (err) { rect = null; }
    if (!rect || !rect.width || !rect.height) { eyeHome(tracker); return; }
    eyeAim(tracker, tracker.left, rect);
    eyeAim(tracker, tracker.right, rect);
  }
  function eyeTick() {
    for (var i = 0; i < eyeTrackers.length; i += 1) eyeUpdate(eyeTrackers[i]);
    eyeFrame = eyeTrackers.length ? window.requestAnimationFrame(eyeTick) : null;
  }
  function trackEyes(svgRoot, options) {
    options = options || {};
    var animator = options.animator && typeof options.animator.on === 'function' ? options.animator : null;
    var spec = (animator && animator.spec) || options.spec || {};
    var section = isObject(spec.eyeTracking) ? spec.eyeTracking : {};
    var reference = (spec.meta && spec.meta.reference) || {};
    var inert = { stop: function () {} };
    if (!svgRoot || typeof svgRoot.querySelector !== 'function') return inert;
    if (typeof window === 'undefined' || typeof document === 'undefined' || typeof window.requestAnimationFrame !== 'function') return inert;
    var tracker = {
      root: svgRoot, animator: animator, clips: spec.clips || {}, slots: {},
      maxTravel: numberOr(section.maxTravel, EYE_DEFAULTS.maxTravel), reachPx: numberOr(section.reachPx, EYE_DEFAULTS.reachPx) || EYE_DEFAULTS.reachPx,
      width: numberOr(reference.width, EYE_DEFAULTS.width) || EYE_DEFAULTS.width, height: numberOr(reference.height, EYE_DEFAULTS.height) || EYE_DEFAULTS.height,
      left: eyeBuild(svgRoot, 'L'), right: eyeBuild(svgRoot, 'R')
    };
    function onClipStart(evt) { if (evt && typeof evt.name === 'string' && evt.name.indexOf('face-') === 0) tracker.slots[evt.group] = evt.name; }
    function onClipEnd(evt) { if (evt && !evt.loop && tracker.slots[evt.group] === evt.name) tracker.slots[evt.group] = null; }
    function onStateChange() { for (var group in tracker.slots) if (group !== REACTION_GROUP) tracker.slots[group] = null; }
    if (animator) { animator.on('clipstart', onClipStart); animator.on('clipend', onClipEnd); animator.on('statechange', onStateChange); }
    eyeTrackers.push(tracker);
    if (!eyeListening) {
      document.addEventListener('mousemove', eyeOnMove, { passive: true });
      eyeListening = true;
      if (!eyeMql && window.matchMedia) eyeMql = window.matchMedia('(prefers-reduced-motion: reduce)');
    }
    if (eyeFrame === null) eyeFrame = window.requestAnimationFrame(eyeTick);
    var stopped = false;
    return {
      stop: function () {
        if (stopped) return;
        stopped = true;
        if (animator && typeof animator.off === 'function') { animator.off('clipstart', onClipStart); animator.off('clipend', onClipEnd); animator.off('statechange', onStateChange); }
        var index = eyeTrackers.indexOf(tracker);
        if (index !== -1) eyeTrackers.splice(index, 1);
        eyeHome(tracker);
        if (eyeTrackers.length) return;
        document.removeEventListener('mousemove', eyeOnMove, { passive: true });
        eyeListening = false;
        eyePointer.seen = false;
        if (eyeFrame !== null && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(eyeFrame);
        eyeFrame = null;
      }
    };
  }

  function validateSpec(spec) {
    var problems = [];
    if (!isObject(spec)) problems.push('spec must be an object');
    if (!spec || !isObject(spec.rig)) problems.push('missing rig');
    if (!spec || !isObject(spec.clips)) problems.push('missing clips');
    if (problems.length) throw new Error('Invalid ogre animation spec:\n- ' + problems.join('\n- '));
    var rig = spec.rig || {};
    var clips = spec.clips || {};
    var pools = spec.pools || {};
    var sequences = spec.sequences || {};
    var oneshots = spec.oneshots || {};
    var states = spec.states || {};
    Object.keys(clips).forEach(function (name) {
      var clip = clips[name];
      if (!clip || typeof clip.duration !== 'number') problems.push('clip "' + name + '" missing duration');
      asArray(clip && clip.tracks).forEach(function (track, trackIndex) {
        if (!track.part || !rig[track.part]) problems.push('clip "' + name + '" track ' + trackIndex + ' unknown part ref "' + track.part + '"');
        asArray(track.keyframes).forEach(function (kf, kfIndex) {
          if (typeof kf.t !== 'number' || kf.t < 0 || kf.t > 1) problems.push('clip "' + name + '" track ' + trackIndex + ' keyframe ' + kfIndex + ' t outside [0,1]: ' + kf.t);
        });
      });
    });
    Object.keys(pools).forEach(function (name) {
      asArray(pools[name] && pools[name].items).forEach(function (item, index) {
        if (!clipExists(spec, item && item.ref)) problems.push('pool "' + name + '" item ' + index + ' unknown clip ref "' + (item && item.ref) + '"');
      });
    });
    Object.keys(oneshots).forEach(function (name) {
      var ref = oneshots[name] && oneshots[name].clip;
      if (!clipExists(spec, ref)) problems.push('oneshot "' + name + '" unknown clip ref "' + ref + '"');
    });
    Object.keys(sequences).forEach(function (name) {
      asArray(sequences[name] && sequences[name].steps).forEach(function (step, index) {
        if (step.play && !playableExists(spec, step.play)) problems.push('sequence "' + name + '" step ' + index + ' unknown clip ref "' + step.play + '"');
        asArray(step.parallel).forEach(function (ref) { if (!playableExists(spec, ref)) problems.push('sequence "' + name + '" step ' + index + ' unknown clip ref "' + ref + '"'); });
        if (step.pose && !clipExists(spec, step.pose)) problems.push('sequence "' + name + '" step ' + index + ' unknown clip ref "' + step.pose + '"');
      });
    });
    Object.keys(states).forEach(function (name) {
      var state = states[name] || {};
      ['intro', 'loop', 'outro'].forEach(function (slot) {
        var ref = state.body && state.body[slot];
        if (ref && !clipExists(spec, ref)) problems.push('state "' + name + '" body.' + slot + ' unknown clip ref "' + ref + '"');
      });
      if (state.face) {
        if (state.face.clip && !clipExists(spec, state.face.clip)) problems.push('state "' + name + '" face.clip unknown clip ref "' + state.face.clip + '"');
        if (state.face.pool && !pools[state.face.pool]) problems.push('state "' + name + '" face.pool unknown pool ref "' + state.face.pool + '"');
      }
      Object.keys(state.microLife || {}).forEach(function (key) {
        var ref = state.microLife[key] && state.microLife[key].clip;
        if (ref && !clipExists(spec, ref)) problems.push('state "' + name + '" microLife.' + key + ' unknown clip ref "' + ref + '"');
      });
      asArray(state.effects).forEach(function (effect, index) {
        if (effect.clip && !clipExists(spec, effect.clip)) problems.push('state "' + name + '" effects[' + index + '] unknown clip ref "' + effect.clip + '"');
      });
      if (state.reducedMotion && state.reducedMotion.pose && !clipExists(spec, state.reducedMotion.pose)) problems.push('state "' + name + '" reducedMotion.pose unknown clip ref "' + state.reducedMotion.pose + '"');
    });
    // Spec 0.5.0 (section 13). Each section is optional for a reader; present,
    // it must be well-formed and name only clips, pools and bands that exist.
    var moodOwner = {};
    Object.keys(clips).forEach(function (name) {
      var clip = clips[name];
      if (clip && hasOwn(clip, 'eyeTracking') && typeof clip.eyeTracking !== 'boolean') problems.push('clip "' + name + '" eyeTracking must be a boolean');
      if (!clip || !hasOwn(clip, 'mood')) return;
      if (typeof clip.mood !== 'string' || !MOOD_NAME.test(clip.mood)) { problems.push('clip "' + name + '" mood ' + JSON.stringify(clip.mood) + ' is not a lowercase [a-z_]+ name'); return; }
      if (moodOwner[clip.mood]) problems.push('clip "' + name + '" mood "' + clip.mood + '" duplicates clip "' + moodOwner[clip.mood] + '"');
      else moodOwner[clip.mood] = name;
    });
    var bandNames = [];
    if (hasOwn(spec, 'mood')) {
      var mood = spec.mood;
      if (!isObject(mood)) problems.push('mood must be an object');
      else {
        if (!Array.isArray(mood.bands) || !mood.bands.length) problems.push('mood.bands must be a non-empty array');
        asArray(mood.bands).forEach(function (band, index) {
          if (!isObject(band) || typeof band.name !== 'string' || !MOOD_NAME.test(band.name)) { problems.push('mood.bands[' + index + '] needs a lowercase [a-z_]+ name'); return; }
          if (bandNames.indexOf(band.name) !== -1) problems.push('mood.bands[' + index + '] duplicates band "' + band.name + '"');
          bandNames.push(band.name);
          if (!isObject(band.when)) { problems.push('mood band "' + band.name + '" when must be an object'); return; }
          Object.keys(band.when).forEach(function (axis) {
            var rule = band.when[axis];
            if (MOOD_AXES.indexOf(axis) === -1) problems.push('mood band "' + band.name + '" when.' + axis + ' is not a mood axis (' + MOOD_AXES.join(', ') + ')');
            if (!isObject(rule) || (!hasOwn(rule, 'min') && !hasOwn(rule, 'below'))) { problems.push('mood band "' + band.name + '" when.' + axis + ' needs min and/or below'); return; }
            ['min', 'below'].forEach(function (bound) { if (hasOwn(rule, bound) && typeof rule[bound] !== 'number') problems.push('mood band "' + band.name + '" when.' + axis + '.' + bound + ' must be a number'); });
          });
        });
        if (hasOwn(mood, 'weights')) {
          if (!isObject(mood.weights)) problems.push('mood.weights must be an object');
          else Object.keys(mood.weights).forEach(function (band) {
            if (bandNames.indexOf(band) === -1) problems.push('mood.weights "' + band + '" is not a band name');
            var table = mood.weights[band];
            if (!isObject(table)) { problems.push('mood.weights "' + band + '" must be an object of clip -> multiplier'); return; }
            Object.keys(table).forEach(function (ref) {
              if (!clipExists(spec, ref)) problems.push('mood.weights "' + band + '" unknown clip ref "' + ref + '"');
              var multiplier = table[ref];
              if (typeof multiplier !== 'number' || !isFinite(multiplier) || multiplier < 0 || Math.floor(multiplier) !== multiplier) problems.push('mood.weights "' + band + '" "' + ref + '" must be a non-negative integer multiplier');
            });
          });
        }
      }
    }
    if (hasOwn(spec, 'schedule')) {
      var schedule = spec.schedule;
      if (!isObject(schedule)) problems.push('schedule must be an object');
      else {
        if (typeof schedule.epochMs !== 'number' || !(schedule.epochMs > 0) || Math.floor(schedule.epochMs) !== schedule.epochMs) problems.push('schedule.epochMs must be a positive integer (ms)');
        if (schedule.prng !== 'mulberry32') problems.push('schedule.prng must be "mulberry32" (got ' + JSON.stringify(schedule.prng) + ')');
        if (schedule.seed !== 'fnv1a32') problems.push('schedule.seed must be "fnv1a32" (got ' + JSON.stringify(schedule.seed) + ')');
        if (hasOwn(schedule, 'defaultHoldMs')) {
          var hold = schedule.defaultHoldMs;
          if (!Array.isArray(hold) || hold.length !== 2 || typeof hold[0] !== 'number' || typeof hold[1] !== 'number' || !(hold[0] >= 0) || !(hold[1] >= hold[0])) problems.push('schedule.defaultHoldMs must be [min, max] with 0 <= min <= max');
        }
      }
    }
    if (hasOwn(spec, 'reactions')) {
      if (!isObject(spec.reactions)) problems.push('reactions must be an object');
      else Object.keys(spec.reactions).forEach(function (name) {
        var row = spec.reactions[name];
        if (!isObject(row)) { problems.push('reaction "' + name + '" must be an object'); return; }
        var hasFace = hasOwn(row, 'face');
        var hasPool = hasOwn(row, 'pool');
        if (hasFace === hasPool) problems.push('reaction "' + name + '" needs exactly one of face or pool');
        if (hasFace && row.face !== 'payload' && !clipExists(spec, row.face)) problems.push('reaction "' + name + '" face unknown clip ref "' + row.face + '"');
        if (hasPool && !pools[row.pool]) problems.push('reaction "' + name + '" unknown pool ref "' + row.pool + '"');
        if (hasOwn(row, 'body') && row.body !== 'payload' && !clipExists(spec, row.body)) problems.push('reaction "' + name + '" body unknown clip ref "' + row.body + '"');
        if (typeof row.priority !== 'number' || !isFinite(row.priority)) problems.push('reaction "' + name + '" priority must be a number');
        if (typeof row.holdMs !== 'number' || !(row.holdMs >= 0)) problems.push('reaction "' + name + '" holdMs must be a number >= 0 (0 = held until released)');
        if (hasOwn(row, 'expiresMs') && (typeof row.expiresMs !== 'number' || !(row.expiresMs > 0))) problems.push('reaction "' + name + '" expiresMs must be a positive number');
      });
    }
    if (hasOwn(spec, 'blink')) {
      var blink = spec.blink;
      if (!isObject(blink)) problems.push('blink must be an object');
      else {
        var every = blink.everyMs;
        if (!Array.isArray(every) || every.length !== 2 || typeof every[0] !== 'number' || typeof every[1] !== 'number' || !(every[0] >= 0) || !(every[1] >= every[0])) problems.push('blink.everyMs must be [min, max] with 0 <= min <= max');
        if (typeof blink.durationMs !== 'number' || !(blink.durationMs >= 0)) problems.push('blink.durationMs must be a number >= 0');
        if (!Array.isArray(blink.renderers) || !blink.renderers.every(function (renderer) { return typeof renderer === 'string'; })) problems.push('blink.renderers must be an array of renderer names');
      }
    }
    // Spec 0.6.0 (section 14.1, 14.3). Both sections are optional.
    if (hasOwn(spec, 'costumes')) {
      if (!isObject(spec.costumes)) problems.push('costumes must be an object');
      else Object.keys(spec.costumes).forEach(function (name) {
        var costume = spec.costumes[name];
        if (!isObject(costume)) { problems.push('costume "' + name + '" must be an object'); return; }
        var all = costume.answers === 'all';
        if (!all && !Array.isArray(costume.answers)) problems.push('costume "' + name + '" answers must be "all" or an array of clip names');
        var answered = all ? [] : asArray(costume.answers);
        answered.forEach(function (ref) { if (!clipExists(spec, ref)) problems.push('costume "' + name + '" answers unknown clip ref "' + ref + '"'); });
        var glyphs = {};
        if (hasOwn(costume, 'glyphs')) {
          if (!isObject(costume.glyphs)) problems.push('costume "' + name + '" glyphs must be an object of slot -> glyph names');
          else Object.keys(costume.glyphs).forEach(function (slot) {
            var list = costume.glyphs[slot];
            if (!Array.isArray(list) || !list.length || !list.every(function (glyph) { return typeof glyph === 'string' && glyph; })) { problems.push('costume "' + name + '" glyphs.' + slot + ' must be a non-empty array of glyph names'); return; }
            glyphs[slot] = list;
          });
        }
        function checkGlyphSet(set, where) {
          if (!hasOwn(costume, 'glyphs')) { problems.push('costume "' + name + '" ' + where + ' is a glyph set but the costume declares no glyphs'); return; }
          if (!Object.keys(set).length) problems.push('costume "' + name + '" ' + where + ' is an empty glyph set');
          Object.keys(set).forEach(function (slot) {
            if (!glyphs[slot]) { if (isObject(costume.glyphs) && !hasOwn(costume.glyphs, slot)) problems.push('costume "' + name + '" ' + where + ' unknown glyph slot "' + slot + '"'); return; }
            if (glyphs[slot].indexOf(set[slot]) === -1) problems.push('costume "' + name + '" ' + where + ' ' + slot + ' glyph ' + JSON.stringify(set[slot]) + ' is not declared in glyphs.' + slot);
          });
        }
        if (hasOwn(costume, 'rest')) {
          if (!isObject(costume.rest)) problems.push('costume "' + name + '" rest must be a glyph set');
          else checkGlyphSet(costume.rest, 'rest');
        }
        if (hasOwn(costume, 'clipMap')) {
          if (!isObject(costume.clipMap)) problems.push('costume "' + name + '" clipMap must be an object');
          else Object.keys(costume.clipMap).forEach(function (ref) {
            var target = costume.clipMap[ref];
            if (!clipExists(spec, ref)) problems.push('costume "' + name + '" clipMap unknown clip ref "' + ref + '"');
            if (!all && answered.indexOf(ref) !== -1) problems.push('costume "' + name + '" clip "' + ref + '" is in both answers and clipMap');
            if (isObject(target)) checkGlyphSet(target, 'clipMap "' + ref + '"');
            else if (typeof target !== 'string') problems.push('costume "' + name + '" clipMap "' + ref + '" must be a clip name, "rest" or a glyph set');
            else if (target !== 'rest' && !(all ? clipExists(spec, target) : answered.indexOf(target) !== -1)) problems.push('costume "' + name + '" clipMap "' + ref + '" -> "' + target + '" is not a clip the costume answers (or "rest")');
          });
        }
      });
    }
    if (hasOwn(spec, 'decorations')) {
      if (!isObject(spec.decorations)) problems.push('decorations must be an object');
      else Object.keys(spec.decorations).forEach(function (name) {
        var decoration = spec.decorations[name];
        if (!isObject(decoration)) { problems.push('decoration "' + name + '" must be an object'); return; }
        ['show', 'hide'].forEach(function (list) {
          var ids = decoration[list];
          if (!Array.isArray(ids) || !ids.length || !ids.every(function (id) { return typeof id === 'string' && id; })) problems.push('decoration "' + name + '" ' + list + ' must be a non-empty array of element ids');
        });
      });
    }
    // Spec 0.7.0 (section 15.2). Both sections are optional.
    if (hasOwn(spec, 'gestures')) {
      if (!isObject(spec.gestures)) problems.push('gestures must be an object');
      else Object.keys(spec.gestures).forEach(function (name) {
        if (!/^[a-z][a-z0-9_]{0,23}$/.test(name)) problems.push('gesture "' + name + '" is not a lowercase [a-z][a-z0-9_]{0,23} name');
        if (!isObject(spec.gestures[name])) problems.push('gesture "' + name + '" must be an object');
      });
    }
    if (hasOwn(spec, 'energy')) {
      if (!Array.isArray(spec.energy)) problems.push('energy must be an array');
      else {
        var knownGestures = isObject(spec.gestures) ? spec.gestures : {};
        var seenLevels = {};
        spec.energy.forEach(function (entry, index) {
          var where = 'energy[' + index + ']';
          if (!isObject(entry)) { problems.push(where + ' must be an object'); return; }
          if (typeof entry.level !== 'number' || Math.floor(entry.level) !== entry.level || entry.level < 1 || entry.level > 3) problems.push(where + ' level must be an integer from 1 to 3');
          else if (seenLevels[entry.level]) problems.push(where + ' duplicates level ' + entry.level);
          else seenLevels[entry.level] = true;
          if (typeof entry.name !== 'string' || !entry.name) problems.push(where + ' name must be a non-empty string');
          if (typeof entry.everyMs !== 'number' || Math.floor(entry.everyMs) !== entry.everyMs || entry.everyMs < 250) problems.push(where + ' everyMs must be an integer >= 250');
          if (!Array.isArray(entry.gestures) || !entry.gestures.length) problems.push(where + ' gestures must be a non-empty array of gesture names');
          else entry.gestures.forEach(function (ref) { if (typeof ref !== 'string' || !hasOwn(knownGestures, ref)) problems.push(where + ' unknown gesture ref ' + JSON.stringify(ref)); });
        });
      }
    }
    // Spec 0.7.0: eye tracking. The section is optional, and so is a clip's flag (checked with the clips above).
    if (hasOwn(spec, 'eyeTracking')) {
      if (!isObject(spec.eyeTracking)) problems.push('eyeTracking must be an object');
      else ['maxTravel', 'reachPx'].forEach(function (key) {
        var value = spec.eyeTracking[key];
        if (typeof value !== 'number' || !isFinite(value) || !(value > 0)) problems.push('eyeTracking.' + key + ' must be a positive number');
      });
    }
    if (problems.length) throw new Error('Invalid ogre animation spec:\n- ' + problems.join('\n- '));
    return true;
  }
  function compileSpec(spec) {
    var compiled = { meta: clone(spec.meta || {}), rig: clone(spec.rig || {}), clips: {}, pools: clone(spec.pools || {}), sequences: clone(spec.sequences || {}), oneshots: clone(spec.oneshots || {}), states: clone(spec.states || {}), reducedMotionDefaults: clone(spec.reducedMotionDefaults || {}), mood: isObject(spec.mood) ? clone(spec.mood) : null, schedule: isObject(spec.schedule) ? clone(spec.schedule) : null, reactions: clone(spec.reactions || {}), blink: isObject(spec.blink) ? clone(spec.blink) : null, costumes: clone(spec.costumes || {}), decorations: clone(spec.decorations || {}), gestures: clone(spec.gestures || {}), energy: clone(spec.energy || []), eyeTracking: isObject(spec.eyeTracking) ? clone(spec.eyeTracking) : null };
    Object.keys(spec.clips || {}).forEach(function (name) {
      var clip = spec.clips[name];
      var out = { name: name, duration: clip.duration, loop: clip.loop === true, meta: clone(clip.meta || {}), mouthViseme: clip.mouthViseme || null, mood: typeof clip.mood === 'string' ? clip.mood : null, eyeTracking: clip.eyeTracking !== false, tracks: asArray(clip.tracks).map(function (track) { return compileTrack(clip, track); }) };
      out.parts = getClipParts(out);
      compiled.clips[name] = out;
    });
    return compiled;
  }
  function load(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('Failed to load ' + url + ': ' + res.status);
      return res.json();
    }).then(function (spec) { validateSpec(spec); return compileSpec(spec); });
  }
  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
    return String(value).replace(/([ #.;?+*~':"!^$[\]()=>|/@])/g, '\\$1');
  }
  function attrEscape(value) { return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
  function priorityValue(value) { if (typeof value === 'number') return value; return PRIORITY[value] || PRIORITY.oneshot; }
  function makeCancelError() { var err = new Error('Animation canceled'); err.name = 'AbortError'; return err; }
  // The pose a part shows right now (its animated computed style), used as the
  // 0% keyframe of a blend. null when there is no computed style to read
  // (Node, detached elements).
  function readComputedPose(el) {
    if (typeof getComputedStyle !== 'function') return null;
    var style = null;
    try { style = getComputedStyle(el); } catch (err) { style = null; }
    if (!style) return null;
    var opacity = parseFloat(style.opacity);
    return { transform: style.transform && style.transform !== 'none' ? style.transform : 'none', opacity: isFinite(opacity) ? opacity : 1 };
  }

  function OgreAnimator(rootEl, compiledSpec, opts) {
    opts = opts || {};
    if (!rootEl) throw new Error('OgreAnimator requires a root element');
    if (!compiledSpec || !compiledSpec.clips) throw new Error('OgreAnimator requires a compiled spec');
    this.rootEl = rootEl;
    this.bodyEl = opts.bodyEl || rootEl;
    this.spec = compiledSpec;
    this.microLifeScale = opts.microLifeScale || 1;
    this.random = opts.random || Math.random; // micro-life, effects and blink only; state faces follow the shared schedule (13.3)
    this._now = typeof opts.now === 'function' ? opts.now : Date.now; // the renderer's wall clock, Unix ms (injectable for tests)
    this._scheduleKey = typeof opts.scheduleKey === 'string' && opts.scheduleKey ? opts.scheduleKey : DEFAULT_KEY;
    this._moodBand = DEFAULT_BAND;
    this._reaction = null; // the active react() record: { name, face, body, resolve }
    this._state = null;
    this._token = 0;
    this._events = {};
    this._parts = {};
    this._warnedParts = {};
    this._owners = typeof Map !== 'undefined' ? new Map() : null;
    this._animations = [];
    this._groupAnimations = {};
    this._timers = [];
    this._recentPools = {};
    this._scrubs = {};
    this._blendSnapshot = null; // Map el -> pose taken by setState before it cancels the old state (10.3)
    this._expressionMouthViseme = null;
    this._speechMouthViseme = null;
    this._speechVisemeOwner = null;
    this._visibilityHidden = false;
    this._reducedMotionMode = opts.reducedMotion === undefined ? 'auto' : opts.reducedMotion;
    this._reducedMotion = false;
    this._mql = null;
    this._mqlHandler = null;
    this._visibilityHandler = this._onVisibilityChange.bind(this);
    this._resolveParts();
    this._setupReducedMotion();
    if (opts.moodBand !== undefined) this._moodBand = this._bandOrCalm(opts.moodBand);
    if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', this._visibilityHandler);
  }
  Object.defineProperty(OgreAnimator.prototype, 'state', { get: function () { return this._state; } });
  Object.defineProperty(OgreAnimator.prototype, 'moodBand', { get: function () { return this._moodBand; } });
  Object.defineProperty(OgreAnimator.prototype, 'scheduleKey', { get: function () { return this._scheduleKey; } });
  Object.defineProperty(OgreAnimator.prototype, 'activeReaction', { get: function () { return this._reaction ? this._reaction.name : null; } });
  OgreAnimator.prototype.on = function (evt, cb) { if (!this._events[evt]) this._events[evt] = []; this._events[evt].push(cb); return this; };
  OgreAnimator.prototype.off = function (evt, cb) { var list = this._events[evt]; if (!list) return this; this._events[evt] = list.filter(function (fn) { return fn !== cb; }); return this; };
  OgreAnimator.prototype._emit = function (evt, payload) { asArray(this._events[evt]).slice().forEach(function (cb) { try { cb(payload); } catch (err) { setTimeout(function () { throw err; }, 0); } }); };
  OgreAnimator.prototype._setupReducedMotion = function () {
    var self = this;
    if (this._reducedMotionMode === 'auto' && typeof window !== 'undefined' && window.matchMedia) {
      this._mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._reducedMotion = !!this._mql.matches;
      this._mqlHandler = function (evt) { self._reducedMotion = !!evt.matches; if (self._state) self.setState(self._state, true); };
      if (this._mql.addEventListener) this._mql.addEventListener('change', this._mqlHandler);
      else if (this._mql.addListener) this._mql.addListener(this._mqlHandler);
    } else {
      this._reducedMotion = this._reducedMotionMode === true;
    }
  };
  OgreAnimator.prototype.setReducedMotion = function (value) {
    if (value === 'auto') { this._reducedMotionMode = 'auto'; this._reducedMotion = !!(this._mql && this._mql.matches); }
    else { this._reducedMotionMode = !!value; this._reducedMotion = !!value; }
    if (this._state) this.setState(this._state, true);
  };
  OgreAnimator.prototype._resolveParts = function () {
    var rig = this.spec.rig || {};
    var self = this;
    Object.keys(rig).forEach(function (part) {
      if (part === 'root') { self._parts[part] = [self.bodyEl]; return; }
      var matches = [];
      asArray(rig[part] && rig[part].match).forEach(function (id) {
        var found = null;
        try { found = self.rootEl.querySelector('.ogre-' + cssEscape(id)); } catch (err1) {}
        if (!found) { try { found = self.rootEl.querySelector('#' + cssEscape(id)); } catch (err2) {} }
        if (!found) { try { found = self.rootEl.querySelector('[id^="' + attrEscape(id) + '_"]'); } catch (err3) {} }
        if (found && matches.indexOf(found) === -1) matches.push(found);
      });
      self._parts[part] = matches;
      if (!matches.length && !self._warnedParts[part] && typeof console !== 'undefined' && console.warn) { self._warnedParts[part] = true; console.warn('OgreAnimator: missing rig part "' + part + '"'); }
    });
  };
  OgreAnimator.prototype.listParts = function () { var self = this; return Object.keys(this.spec.rig || {}).map(function (part) { return { part: part, matched: asArray(self._parts[part]).length }; }); };
  OgreAnimator.prototype._setTimer = function (fn, ms, group, token) {
    var timer = { fn: fn, remaining: Math.max(0, ms || 0), group: group || 'default', token: token, id: null, start: Date.now() };
    var self = this;
    function fire() { self._timers = self._timers.filter(function (item) { return item !== timer; }); if (token === undefined || token === self._token) fn(); }
    timer.id = setTimeout(fire, timer.remaining);
    this._timers.push(timer);
    return timer;
  };
  OgreAnimator.prototype._clearTimers = function (group) { this._timers = this._timers.filter(function (timer) { if (!group || timer.group === group) { if (timer.id) clearTimeout(timer.id); return false; } return true; }); };
  OgreAnimator.prototype._trackAnimation = function (animation, group) { if (!animation) return; this._animations.push(animation); group = group || 'default'; if (!this._groupAnimations[group]) this._groupAnimations[group] = []; this._groupAnimations[group].push(animation); };
  OgreAnimator.prototype._untrackAnimation = function (animation) {
    this._animations = this._animations.filter(function (item) { return item !== animation; });
    Object.keys(this._groupAnimations).forEach(function (group) { this._groupAnimations[group] = this._groupAnimations[group].filter(function (item) { return item !== animation; }); }, this);
  };
  OgreAnimator.prototype._cancelAnimation = function (animation) {
    if (!animation) return;
    // A clip's blend (10.3) lives and dies with the clip.
    if (animation.__ogreBlendAnimation) { var blend = animation.__ogreBlendAnimation; animation.__ogreBlendAnimation = null; this._cancelAnimation(blend); }
    try { animation.cancel(); } catch (err) {}
    this._untrackAnimation(animation);
    if (this._owners) { var owners = this._owners; owners.forEach(function (record, el) { if (record.animation === animation) owners.delete(el); }); }
  };
  OgreAnimator.prototype._setMouthViseme = function (letter) {
    var root = this.rootEl;
    if (!root) return;
    var svg = (root.matches && root.matches('svg')) ? root : (root.querySelector ? root.querySelector('svg') : null);
    if (!svg) return;
    if (letter) svg.setAttribute('data-mouth', letter);
    else svg.removeAttribute('data-mouth');
  };
  OgreAnimator.prototype._renderMouthViseme = function () {
    this._setMouthViseme(this._speechVisemeOwner ? this._speechMouthViseme : this._expressionMouthViseme);
  };
  OgreAnimator.prototype._setExpressionMouthViseme = function (letter) {
    this._expressionMouthViseme = letter || null;
    this._renderMouthViseme();
  };
  // Acquire with setViseme(letter), then pass the returned opaque owner token
  // for every update and release: setViseme(nextLetter, owner),
  // setViseme(null, owner). Stale owners are intentionally ignored.
  OgreAnimator.prototype.setViseme = function (letter, owner) {
    if (letter !== null && letter !== undefined) {
      letter = String(letter).toUpperCase();
      if (!/^[A-HX]$/.test(letter)) throw new Error('Invalid viseme: ' + letter);
      if (owner) {
        if (owner !== this._speechVisemeOwner) return owner;
      } else {
        owner = {};
        this._speechVisemeOwner = owner;
      }
      this._speechMouthViseme = letter;
      this._renderMouthViseme();
      return owner;
    }
    if (owner && owner === this._speechVisemeOwner) {
      this._speechVisemeOwner = null;
      this._speechMouthViseme = null;
      this._renderMouthViseme();
    }
    return owner || null;
  };
  OgreAnimator.prototype._cancelGroup = function (group) { this._clearTimers(group); asArray(this._groupAnimations[group]).slice().forEach(this._cancelAnimation.bind(this)); this._groupAnimations[group] = []; if (group === 'face') this._setExpressionMouthViseme(null); };
  OgreAnimator.prototype._partsOwnedAbove = function (parts, priority) {
    if (!this._owners) return false;
    var self = this;
    return parts.some(function (part) { return asArray(self._parts[part]).some(function (el) { var owner = self._owners.get(el); return owner && owner.priority > priority; }); });
  };
  OgreAnimator.prototype._animateElement = function (el, keyframes, timing, priority, group) {
    if (!el || !el.animate) return null;
    if (this._owners) {
      var owner = this._owners.get(el);
      if (owner) { if (priority < owner.priority) return null; this._cancelAnimation(owner.animation); }
    }
    var animation = el.animate(keyframes, timing);
    animation.__ogrePriority = priority;
    animation.__ogreGroup = group;
    this._trackAnimation(animation, group);
    if (this._owners) this._owners.set(el, { animation: animation, priority: priority });
    return animation;
  };
  // Root (body) offsets are authored in the artwork's units (meta.reference,
  // spec 0.4.0). Face parts are SVG children, so CSS px already are user
  // units; the body element is HTML, so its root clips scale by rendered width
  // over the reference width. 1 when the spec has no reference or nothing is
  // laid out yet (hidden element, Node tests).
  OgreAnimator.prototype.rootScale = function () {
    var reference = this.spec.meta && this.spec.meta.reference;
    var refWidth = reference ? Number(reference.width) : 0;
    if (!isFinite(refWidth) || refWidth <= 0) return 1;
    var width = 0;
    var el = this.bodyEl;
    if (el && typeof el.getBoundingClientRect === 'function') {
      try { width = Number(el.getBoundingClientRect().width) || 0; } catch (err) { width = 0; }
    }
    return width > 0 ? width / refWidth : 1;
  };
  OgreAnimator.prototype._trackKeyframes = function (track, rootScale) {
    if (track.part !== 'root' || rootScale === 1 || !track.frames) return track.keyframes;
    return scaledKeyframes(track.frames, rootScale);
  };
  OgreAnimator.prototype._blendMs = function () {
    var meta = this.spec.meta || {};
    return typeof meta.blendMs === 'number' && isFinite(meta.blendMs) && meta.blendMs >= 0 ? meta.blendMs : DEFAULT_BLEND_MS;
  };
  // Blend on change (spec 0.4.0, 10.3): when a clip replaces another animation
  // on a part, ease from the pose that animation is showing into the clip's
  // first keyframe over meta.blendMs, then play the clip unchanged from that
  // keyframe. The blend is tracked in the clip's group (so group cancels end
  // it), is cancelled with its clip, and never becomes the part's owner.
  // setState cancels every group before the new state's clips start, so those
  // clips would find no owner and never blend. Before the cancel, remember the
  // pose each owned part is showing; _blendSource consumes the entries, and the
  // map is dropped as soon as the clips started by that setState are running
  // (or on stop), because the poses are stale after the next paint.
  // Merges into a snapshot that is still pending (releaseReaction snapshots the
  // reaction's parts before it cancels them, then setState snapshots the rest).
  OgreAnimator.prototype._snapshotPoses = function () {
    if (!this._owners || typeof Map === 'undefined') { this._blendSnapshot = null; return; }
    var snapshot = this._blendSnapshot || new Map();
    this._owners.forEach(function (record, el) { var pose = readComputedPose(el); if (pose) snapshot.set(el, pose); });
    this._blendSnapshot = snapshot.size ? snapshot : null;
  };
  OgreAnimator.prototype._blendSource = function (el) {
    if (this._owners && this._owners.get(el)) return readComputedPose(el);
    if (this._blendSnapshot && this._blendSnapshot.has(el)) { var pose = this._blendSnapshot.get(el); this._blendSnapshot.delete(el); return pose; }
    return null; // nobody owns it and nothing was snapshotted: no visible pose to leave
  };
  OgreAnimator.prototype._startBlend = function (el, animation, from, first, blendMs, priority, group) {
    if (!el || !el.animate || !first) return null;
    var to = { transform: first.transform, opacity: hasOwn(first, 'opacity') ? first.opacity : 1 };
    var blend = null;
    try { blend = el.animate([{ transform: from.transform, opacity: from.opacity }, to], { duration: blendMs, easing: 'ease-out', fill: 'none', iterations: 1 }); } catch (err) { blend = null; }
    if (!blend) return null;
    blend.__ogrePriority = priority;
    blend.__ogreGroup = group;
    blend.__ogreBlend = true;
    this._trackAnimation(blend, group);
    animation.__ogreBlendAnimation = blend;
    var self = this;
    function done() { self._untrackAnimation(blend); if (animation.__ogreBlendAnimation === blend) animation.__ogreBlendAnimation = null; }
    if (blend.finished && blend.finished.then) blend.finished.then(done, done);
    return blend;
  };
  OgreAnimator.prototype._playClip = function (clipName, opts) {
    opts = opts || {};
    var clip = this.spec.clips[clipName];
    if (!clip) return Promise.reject(new Error('Unknown clip: ' + clipName));
    var self = this;
    var token = opts.token;
    var priority = priorityValue(opts.priority || 'oneshot');
    var group = opts.group || (opts.priority === 'face' ? 'face' : 'oneshot');
    var finiteAnimations = [];
    var loop = clip.loop && !opts.forceFinite;
    var canceled = false;
    if (this._partsOwnedAbove(clip.parts, priority)) return Promise.resolve({ cancel: function () {} });
    // Face group owns the mouth: reveal this clip's mapped viseme (or clear to
    // the legacy mouth) once the clip has actually committed to playing.
    if (group === 'face') this._setExpressionMouthViseme(clip.mouthViseme || null);
    this._emit('clipstart', { name: clipName, group: group });
    var blendMs = opts.pose || opts.blend === false ? 0 : this._blendMs();
    var rootScale = this.rootScale();
    clip.tracks.forEach(function (track) {
      var keyframes = self._trackKeyframes(track, rootScale);
      asArray(self._parts[track.part]).forEach(function (el) {
        var timing = Object.assign({}, track.timing);
        if (opts.pose) { timing.duration = 0; timing.delay = 0; timing.iterations = 1; timing.fill = 'forwards'; }
        if (opts.fill) timing.fill = opts.fill;
        var frames = opts.pose ? [keyframes[keyframes.length - 1]] : keyframes;
        // Read the current pose BEFORE _animateElement cancels the owner: cancelling snaps the part back.
        var blendFrom = blendMs > 0 && frames.length ? self._blendSource(el) : null;
        if (blendFrom) { timing.delay = (timing.delay || 0) + blendMs; timing.fill = 'forwards'; }
        var animation = self._animateElement(el, frames, timing, priority, group);
        if (!animation) return;
        if (blendFrom) self._startBlend(el, animation, blendFrom, frames[0], blendMs, priority, group);
        if (!loop) finiteAnimations.push(animation);
        if (animation.finished && animation.finished.catch) animation.finished.catch(function () {});
      });
    });
    function handle() { return { cancel: function () { canceled = true; finiteAnimations.forEach(self._cancelAnimation.bind(self)); } }; }
    if (loop) { this._emit('clipend', { name: clipName, group: group, loop: true }); return Promise.resolve(handle()); }
    if (!finiteAnimations.length) { this._emit('clipend', { name: clipName, group: group, skipped: true }); return Promise.resolve(handle()); }
    return new Promise(function (resolve, reject) {
      var remaining = finiteAnimations.length;
      finiteAnimations.forEach(function (animation) {
        var done = animation.finished || Promise.resolve();
        done.then(function () {
          self._untrackAnimation(animation);
          remaining -= 1;
          if (remaining === 0) {
            if (token !== undefined && token !== self._token) { reject(makeCancelError()); return; }
            self._emit('clipend', { name: clipName, group: group });
            resolve(handle());
          }
        }, function () {
          self._untrackAnimation(animation);
          if (canceled || (token !== undefined && token !== self._token)) reject(makeCancelError());
          else resolve(handle());
        });
      });
    });
  };
  OgreAnimator.prototype.play = function (name, opts) {
    opts = opts || {};
    var oneshot = this.spec.oneshots[name];
    if (oneshot) return this.play(oneshot.clip, Object.assign({}, opts, { priority: opts.priority || 'oneshot', group: opts.group || 'oneshot' }));
    if (this.spec.clips[name]) {
      if (this._reducedMotion && !this.spec.clips[name].loop) { this.pose(name, opts); return Promise.resolve({ cancel: function () {} }); }
      return this._playClip(name, opts);
    }
    if (this.spec.sequences[name]) return this._playSequence(name, opts);
    return Promise.reject(new Error('Unknown animation: ' + name));
  };
  OgreAnimator.prototype._playSequence = function (name, opts) {
    opts = opts || {};
    var sequence = this.spec.sequences[name];
    var self = this;
    var token = opts.token === undefined ? this._token : opts.token;
    var steps = asArray(sequence.steps);
    var index = 0;
    function wait(ms) { return new Promise(function (resolve, reject) { self._setTimer(function () { if (token !== self._token) reject(makeCancelError()); else resolve(); }, ms, opts.group || 'sequence', token); }); }
    function runStep(step) {
      if (token !== self._token) return Promise.reject(makeCancelError());
      if (step.wait !== undefined) return wait(step.wait);
      if (step.pose) { self.pose(step.pose, opts); return Promise.resolve(); }
      if (step.play) return self.play(step.play, Object.assign({}, opts, { token: token }));
      if (step.parallel) return Promise.all(step.parallel.map(function (ref, i) { return wait((step.stagger || 0) * i).then(function () { return self.play(ref, Object.assign({}, opts, { token: token })); }); }));
      return Promise.resolve();
    }
    function loop() {
      if (token !== self._token) return Promise.reject(makeCancelError());
      if (index >= steps.length) { if (typeof sequence.loopFrom === 'number') index = sequence.loopFrom; else return Promise.resolve({ cancel: function () {} }); }
      return runStep(steps[index++]).then(loop);
    }
    return loop();
  };
  // Cancel one presentation overlay without stopping ambient/body state.
  OgreAnimator.prototype.cancelGroup = function (group) {
    this._cancelGroup(group);
    // Finished fill-both animations are no longer tracked, but still own parts.
    var self = this;
    this._owners.forEach(function (owner) {
      if (owner.animation.__ogreGroup === group) self._cancelAnimation(owner.animation);
    });
  };
  OgreAnimator.prototype.pose = function (clipName, opts) { opts = opts || {}; return this._playClip(clipName, Object.assign({}, opts, { pose: true, forceFinite: true, priority: opts.priority || 'pose', group: opts.group || 'pose' })); };
  OgreAnimator.prototype.scrub = function (clipName, t01) {
    var clip = this.spec.clips[clipName];
    if (!clip) throw new Error('Unknown clip: ' + clipName);
    var self = this;
    var key = clipName;
    if (!this._scrubs[key]) this._scrubs[key] = [];
    if (!this._scrubs[key].length) {
      var rootScale = this.rootScale();
      clip.tracks.forEach(function (track) {
        var keyframes = self._trackKeyframes(track, rootScale);
        asArray(self._parts[track.part]).forEach(function (el) {
          if (!el.animate) return;
          var animation = self._animateElement(el, keyframes, Object.assign({}, track.timing, { fill: 'both', iterations: 1 }), PRIORITY.scrub, 'scrub');
          if (animation) { animation.pause(); self._scrubs[key].push({ animation: animation, duration: clip.duration }); }
        });
      });
    }
    this._scrubs[key].forEach(function (record) { record.animation.currentTime = Math.max(0, Math.min(1, t01)) * record.duration; if (record.animation.pause) record.animation.pause(); });
  };
  OgreAnimator.prototype._pickPool = function (poolName) {
    var pool = this.spec.pools[poolName];
    var items = asArray(pool && pool.items);
    if (!items.length) return null;
    var recent = this._recentPools[poolName] || [];
    var windowSize = Math.max(0, pool.noRepeatWindow || 0);
    var candidates = items.filter(function (item) { return recent.indexOf(item.ref) === -1; });
    if (!candidates.length) candidates = items;
    var total = candidates.reduce(function (sum, item) { return sum + (item.weight || 1); }, 0);
    var roll = this.random() * total;
    var pick = candidates[0].ref;
    for (var i = 0; i < candidates.length; i += 1) { roll -= candidates[i].weight || 1; if (roll <= 0) { pick = candidates[i].ref; break; } }
    recent.push(pick);
    while (recent.length > windowSize) recent.shift();
    this._recentPools[poolName] = recent;
    return pick;
  };
  OgreAnimator.prototype._randRange = function (range) { range = range || [0, 0]; var min = Number(range[0]) || 0; var max = Number(range[1]) || min; return min + this.random() * (max - min); };
  // The shared schedule's entry for the current state at the wall clock (13.3).
  OgreAnimator.prototype._scheduleEntry = function () {
    return scheduleAt(this.spec, { key: this._scheduleKey, state: this._state, band: this._moodBand, nowMs: this._now() });
  };
  // A pool state's face comes from the shared schedule, never a local random:
  // scheduleAt(key, state, band, now) names the clip and where its entry ends,
  // the next timer fires there, and the straddling entry is cut at the epoch
  // end, so the epoch-boundary recompute falls out of the same timer. A clip
  // the schedule keeps across two entries (or an epoch boundary) is left
  // running rather than restarted. A fixed face.clip state is unchanged.
  OgreAnimator.prototype._startFace = function (state, token) {
    var self = this;
    if (!state.face) return;
    if (state.face.pool) {
      var current = null;
      var tick = function () {
        if (token !== self._token) return;
        var entry = self._scheduleEntry();
        if (!entry) return;
        if (entry.clip !== current) {
          var clip = self.spec.clips[entry.clip];
          if (clip && !self._partsOwnedAbove(clip.parts, PRIORITY.face)) {
            current = entry.clip;
            self.play(entry.clip, { priority: 'face', group: 'face', token: token }).catch(function () {});
          } else current = null; // blocked by a reaction or a pose: try again at the next entry
        }
        self._setTimer(tick, Math.max(1, entry.endsAtMs - self._now()), 'face', token);
      };
      tick();
    } else if (state.face.clip) this.play(state.face.clip, { priority: 'face', group: 'face', token: token }).catch(function () {});
  };
  // ---- Mood band and schedule key (13.2, 13.3) ----
  OgreAnimator.prototype._bandOrCalm = function (band) {
    if (typeof band !== 'string' || !band) return DEFAULT_BAND;
    var names = asArray(this.spec.mood && this.spec.mood.bands).map(function (entry) { return entry && entry.name; });
    return names.length && names.indexOf(band) === -1 ? DEFAULT_BAND : band;
  };
  // A band or key change re-seeds the schedule at once: the face timers go and
  // the pool face is re-picked (it may change). Body, micro-life and effects
  // are untouched; a fixed face.clip state has no schedule; nothing happens
  // while no schedule timer is running (the face has not started yet, or
  // reduced motion posed it) - the next start reads the new band anyway.
  OgreAnimator.prototype._rejoinSchedule = function () {
    var state = this._state ? this.spec.states[this._state] : null;
    if (!state || !state.face || !state.face.pool || this._reducedMotion) return;
    if (!this._timers.some(function (timer) { return timer.group === 'face'; })) return;
    this._clearTimers('face');
    this._startFace(state, this._token);
  };
  OgreAnimator.prototype.setMoodBand = function (band) {
    band = this._bandOrCalm(band);
    if (band !== this._moodBand) { this._moodBand = band; this._rejoinSchedule(); }
    return band;
  };
  OgreAnimator.prototype.setMoodVector = function (vector) { return this.setMoodBand(moodBandFor(this.spec, vector)); };
  OgreAnimator.prototype.setScheduleKey = function (key) {
    key = typeof key === 'string' && key ? key : DEFAULT_KEY;
    if (key !== this._scheduleKey) { this._scheduleKey = key; this._rejoinSchedule(); }
    return key;
  };
  // ---- Reactions (13.4): what happens to him is shared ----
  // Plays the row's face (a pool pick, or the payload's clip for a "payload"
  // row) and body at the row's priority in the 'reaction' group for holdMs
  // (0 = until releaseReaction(name)), then cancels the group and re-asserts
  // the current state, which rejoins the shared schedule. A newer reaction
  // replaces the current one. Resolves when the reaction ends; rejects only
  // for an unknown name. payload.at (Unix ms) is checked against expiresMs.
  OgreAnimator.prototype.react = function (name, payload) {
    var row = this.spec.reactions ? this.spec.reactions[name] : null;
    if (!isObject(row)) return Promise.reject(new Error('Unknown reaction: ' + name));
    payload = isObject(payload) ? payload : {};
    var now = this._now();
    if (typeof row.expiresMs === 'number' && typeof payload.at === 'number' && now - payload.at > row.expiresMs) return Promise.resolve({ name: name, face: null, body: null, played: false, reason: 'expired' });
    var face = reactionClip(this.spec, name, { key: this._scheduleKey, nowMs: now, payload: payload });
    var body = row.body === 'payload' ? (typeof payload.body === 'string' ? payload.body : null) : (typeof row.body === 'string' ? row.body : null);
    if (face && !this.spec.clips[face]) face = null; // a payload naming a clip this spec lacks plays nothing for that slot
    if (body && !this.spec.clips[body]) body = null;
    var priority = numberOr(row.priority, PRIORITY.oneshot);
    var self = this;
    // Replacing a reaction: snapshot its pose so the new clips blend out of it.
    // The snapshot is dropped afterwards unless a setState's own is pending.
    var ownSnapshot = false;
    if (this._reaction) { ownSnapshot = !this._blendSnapshot; this._snapshotPoses(); this._endReaction('replaced'); }
    var record = { name: name, face: face, body: body, resolve: null };
    var promise = new Promise(function (resolve) { record.resolve = resolve; });
    this._reaction = record;
    if (face) this.play(face, { priority: priority, group: REACTION_GROUP }).catch(function () {});
    if (body) this.play(body, { priority: priority, group: REACTION_GROUP }).catch(function () {});
    if (ownSnapshot) this._blendSnapshot = null;
    this._emit('reaction', { name: name, face: face, body: body, holdMs: row.holdMs, priority: priority });
    // No token: a reaction outlives a state change (setState leaves its group alone).
    if (row.holdMs > 0) this._setTimer(function () { self.releaseReaction(name); }, row.holdMs, REACTION_GROUP);
    return promise;
  };
  OgreAnimator.prototype.releaseReaction = function (name) {
    if (!this._reaction || (name !== undefined && this._reaction.name !== name)) return false;
    this._snapshotPoses(); // the reaction's pose, so the state's clips blend out of it
    this._endReaction('released');
    if (this._state) this.setState(this._state, true);
    else this._blendSnapshot = null;
    return true;
  };
  OgreAnimator.prototype._endReaction = function (reason) {
    var record = this._reaction;
    this._reaction = null;
    this._clearTimers(REACTION_GROUP);
    this.cancelGroup(REACTION_GROUP);
    if (record) record.resolve({ name: record.name, face: record.face, body: record.body, played: true, reason: reason });
  };
  // ---- Blink (13.5): timing shared through the spec, art per renderer ----
  OgreAnimator.prototype.blinkTiming = function () {
    var blink = this.spec.blink;
    if (!isObject(blink)) return null;
    return { everyMs: asArray(blink.everyMs).slice(0, 2).map(Number), durationMs: numberOr(blink.durationMs, 0), renderers: asArray(blink.renderers).slice() };
  };
  // The browser has no lid art yet: this plays nothing until blink.renderers
  // lists "browser" AND the spec carries a face-blink clip (13.5).
  OgreAnimator.prototype._startBlink = function (state, token) {
    var timing = this.blinkTiming();
    if (!timing || timing.renderers.indexOf('browser') === -1 || !this.spec.clips[BLINK_CLIP]) return;
    var self = this;
    function schedule() { self._setTimer(fire, self._randRange(timing.everyMs), 'blink', token); }
    function fire() { if (token !== self._token) return; self.play(BLINK_CLIP, { priority: 'face', group: 'blink', token: token, forceFinite: true }).catch(function () {}); schedule(); }
    schedule();
  };
  // ---- Friendly mood names (13.1) ----
  OgreAnimator.prototype.clipMood = function (name) { var clip = this.spec.clips[name]; return clip && typeof clip.mood === 'string' ? clip.mood : null; };
  OgreAnimator.prototype.clipForMood = function (mood) { return clipForMood(this.spec, mood); };
  OgreAnimator.prototype._startMicroLife = function (state, token) {
    var self = this;
    Object.keys(state.microLife || {}).forEach(function (key) {
      var entry = state.microLife[key];
      function schedule() { var scale = self.microLifeScale > 0 ? self.microLifeScale : 1; self._setTimer(fire, self._randRange([entry.minDelay, entry.maxDelay]) / scale, 'microlife', token); }
      function fire() { if (token !== self._token) return; var clip = self.spec.clips[entry.clip]; if (clip && !self._partsOwnedAbove(clip.parts, PRIORITY.microlife)) self.play(entry.clip, { priority: 'microlife', group: 'microlife', token: token }).catch(function () {}); schedule(); }
      schedule();
    });
  };
  OgreAnimator.prototype._startEffects = function (state, token) {
    var self = this;
    asArray(state.effects).forEach(function (effect) {
      function tick() { if (token !== self._token) return; if (self.random() < (effect.chance || 0)) self.play(effect.clip, { priority: 'oneshot', group: 'effects', token: token }).catch(function () {}); self._setTimer(tick, effect.cooldownMs || 1000, 'effects', token); }
      self._setTimer(tick, effect.cooldownMs || 1000, 'effects', token);
    });
  };
  OgreAnimator.prototype._applyReducedState = function (state) {
    if (state.reducedMotion && state.reducedMotion.pose) return this.pose(state.reducedMotion.pose);
    if (state.face && state.face.clip) return this.pose(state.face.clip, { priority: 'face', group: 'face' });
    if (state.face && state.face.pool) { var pick = this._pickPool(state.face.pool); if (pick) return this.pose(pick, { priority: 'face', group: 'face' }); }
    if (state.body && state.body.loop) return this.pose(state.body.loop, { priority: 'body', group: 'body' });
    return Promise.resolve();
  };
  OgreAnimator.prototype.setState = function (name, force) {
    if (!force && this._state === name) return;
    var state = this.spec.states[name];
    if (!state) throw new Error('Unknown state: ' + name);
    var oldState = this._state ? this.spec.states[this._state] : null;
    this._state = name;
    var token = ++this._token;
    this._snapshotPoses(); // before the cancels below snap every owned part back to rest
    this._cancelGroup('body'); this._cancelGroup('face'); this._cancelGroup('microlife'); this._cancelGroup('effects'); this._cancelGroup('blink'); this._clearTimers('autoreturn');
    this._emit('statechange', { state: name });
    var self = this;
    // The snapshot only describes what is on screen until the next paint, so it
    // is dropped once the clips started by this call are running: after the
    // outro or intro when there is one (the loop and face then start later,
    // from rest), else right after the loop and face have been started.
    function dropSnapshot() { if (token === self._token) self._blendSnapshot = null; }
    function proceed() {
      if (token !== self._token) return;
      if (self._reducedMotion) { self._applyReducedState(state).catch(function () {}); dropSnapshot(); return; }
      var chain = Promise.resolve();
      if (state.body && state.body.intro) chain = chain.then(function () { var intro = self.play(state.body.intro, { priority: 'body', group: 'body', token: token }); dropSnapshot(); return intro; });
      chain.then(function () {
        if (token !== self._token) return;
        if (state.body && state.body.loop) self.play(state.body.loop, { priority: 'body', group: 'body', token: token }).catch(function () {});
        self._startFace(state, token);
        self._startMicroLife(state, token);
        self._startEffects(state, token);
        self._startBlink(state, token);
        if (state.autoReturn) self._setTimer(function () { self.setState(state.autoReturn.to); }, state.autoReturn.afterMs, 'autoreturn', token);
        dropSnapshot();
      }).catch(function () {});
    }
    if (oldState && oldState.body && oldState.body.outro) {
      var outro = this.spec.clips[oldState.body.outro];
      if (outro && outro.duration < 300) { var outroPlay = this.play(oldState.body.outro, { priority: 'body', group: 'body', token: token }); dropSnapshot(); outroPlay.then(proceed, proceed); return; }
    }
    proceed();
  };
  OgreAnimator.prototype._onVisibilityChange = function () {
    if (typeof document === 'undefined') return;
    var hidden = !!document.hidden;
    if (hidden === this._visibilityHidden) return;
    this._visibilityHidden = hidden;
    var now = Date.now();
    if (hidden) {
      this._animations.forEach(function (animation) { try { if (animation.playState === 'running' || animation.playState === 'pending') animation.pause(); } catch (err) {} });
      this._timers.forEach(function (timer) { if (timer.id) clearTimeout(timer.id); timer.remaining = Math.max(0, timer.remaining - (now - timer.start)); timer.id = null; });
    } else {
      var self = this;
      this._animations.forEach(function (animation) { try { if (animation.play) animation.play(); } catch (err) {} });
      this._timers.forEach(function (timer) { if (timer.id) return; timer.start = Date.now(); timer.id = setTimeout(function () { self._timers = self._timers.filter(function (item) { return item !== timer; }); if (timer.token === undefined || timer.token === self._token) timer.fn(); }, timer.remaining); });
    }
  };
  OgreAnimator.prototype.stop = function () {
    this._token += 1;
    if (this._reaction) { var reaction = this._reaction; this._reaction = null; reaction.resolve({ name: reaction.name, face: reaction.face, body: reaction.body, played: true, reason: 'stopped' }); }
    this._clearTimers();
    this._animations.slice().forEach(this._cancelAnimation.bind(this));
    this._animations = [];
    this._groupAnimations = {};
    if (this._owners && this._owners.clear) this._owners.clear();
    this._expressionMouthViseme = null;
    this._speechMouthViseme = null;
    this._speechVisemeOwner = null;
    this._setMouthViseme(null);
    this._scrubs = {};
    this._blendSnapshot = null;
  };
  OgreAnimator.prototype.destroy = function () {
    this.stop();
    if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', this._visibilityHandler);
    if (this._mql && this._mqlHandler) {
      if (this._mql.removeEventListener) this._mql.removeEventListener('change', this._mqlHandler);
      else if (this._mql.removeListener) this._mql.removeListener(this._mqlHandler);
    }
  };

  OgreAnimator.load = load;
  OgreAnimator.validateSpec = validateSpec;
  OgreAnimator.compileSpec = compileSpec;
  OgreAnimator._bakeSpring = bakeSpring;
  // The shared schedule's reference implementation (13.3) and the spec-reading helpers (13.1, 13.2, 13.4).
  OgreAnimator.fnv1a32 = fnv1a32;
  OgreAnimator.mulberry32 = mulberry32;
  OgreAnimator.scheduleSequence = scheduleSequence;
  OgreAnimator.scheduleAt = scheduleAt;
  OgreAnimator.reactionClip = reactionClip;
  OgreAnimator.moodBandFor = moodBandFor;
  OgreAnimator.moodNames = moodNames;
  OgreAnimator.clipForMood = clipForMood;
  // Costumes and decorations (14.1, 14.3): one resolver and one switch for every host.
  OgreAnimator.costumeAnswer = costumeAnswer;
  OgreAnimator.decorate = decorate;
  // Gestures and energy (15.2): the names a line may use. Read, never played here.
  OgreAnimator.gestureNames = gestureNames;
  OgreAnimator.energyLevel = energyLevel;
  // Eye tracking: the pupils follow the pointer on any host's copy of the rig.
  OgreAnimator.trackEyes = trackEyes;

  if (typeof window !== 'undefined') window.OgreAnimator = OgreAnimator;
  if (typeof module !== 'undefined' && module.exports) module.exports = OgreAnimator;
})();
