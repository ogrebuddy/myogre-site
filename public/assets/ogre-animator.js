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
  function compiledFrame(kf) {
    var scale = normalizeScale(kf);
    var x = numberOr(kf.x, 0);
    var y = numberOr(kf.y, 0);
    var rotate = numberOr(kf.rotate, 0);
    var out = { offset: numberOr(kf.t, 0), transform: 'translate(' + x + 'px,' + y + 'px) rotate(' + rotate + 'deg) scale(' + scale.x + ',' + scale.y + ')' };
    if (hasOwn(kf, 'opacity')) out.opacity = Number(kf.opacity);
    if (hasOwn(kf, 'visible')) out.visibility = kf.visible ? 'visible' : 'hidden';
    var easing = easingToCss(kf.easing);
    if (easing) out.easing = easing;
    return out;
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
    var frames = expandSpringTrack(track).map(compiledFrame);
    return { part: track.part, keyframes: frames, timing: { duration: clip.duration, delay: track.delay || 0, iterations: clip.loop === true ? Infinity : (clip.loop || 1), easing: springTrack ? 'linear' : (easingToCss(track.easing) || 'linear'), fill: 'both' }, meta: track.meta || null };
  }
  function getClipParts(compiledClip) {
    var seen = {};
    var parts = [];
    asArray(compiledClip.tracks).forEach(function (track) { if (!seen[track.part]) { seen[track.part] = true; parts.push(track.part); } });
    return parts;
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
    if (problems.length) throw new Error('Invalid ogre animation spec:\n- ' + problems.join('\n- '));
    return true;
  }
  function compileSpec(spec) {
    var compiled = { meta: clone(spec.meta || {}), rig: clone(spec.rig || {}), clips: {}, pools: clone(spec.pools || {}), sequences: clone(spec.sequences || {}), oneshots: clone(spec.oneshots || {}), states: clone(spec.states || {}), reducedMotionDefaults: clone(spec.reducedMotionDefaults || {}) };
    Object.keys(spec.clips || {}).forEach(function (name) {
      var clip = spec.clips[name];
      var out = { name: name, duration: clip.duration, loop: clip.loop === true, meta: clone(clip.meta || {}), mouthViseme: clip.mouthViseme || null, tracks: asArray(clip.tracks).map(function (track) { return compileTrack(clip, track); }) };
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

  function OgreAnimator(rootEl, compiledSpec, opts) {
    opts = opts || {};
    if (!rootEl) throw new Error('OgreAnimator requires a root element');
    if (!compiledSpec || !compiledSpec.clips) throw new Error('OgreAnimator requires a compiled spec');
    this.rootEl = rootEl;
    this.bodyEl = opts.bodyEl || rootEl;
    this.spec = compiledSpec;
    this.microLifeScale = opts.microLifeScale || 1;
    this.random = opts.random || Math.random;
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
    if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', this._visibilityHandler);
  }
  Object.defineProperty(OgreAnimator.prototype, 'state', { get: function () { return this._state; } });
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
    clip.tracks.forEach(function (track) {
      asArray(self._parts[track.part]).forEach(function (el) {
        var timing = Object.assign({}, track.timing);
        if (opts.pose) { timing.duration = 0; timing.delay = 0; timing.iterations = 1; timing.fill = 'forwards'; }
        if (opts.fill) timing.fill = opts.fill;
        var frames = opts.pose ? [track.keyframes[track.keyframes.length - 1]] : track.keyframes;
        var animation = self._animateElement(el, frames, timing, priority, group);
        if (!animation) return;
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
  OgreAnimator.prototype.pose = function (clipName, opts) { opts = opts || {}; return this._playClip(clipName, Object.assign({}, opts, { pose: true, forceFinite: true, priority: opts.priority || 'pose', group: opts.group || 'pose' })); };
  OgreAnimator.prototype.scrub = function (clipName, t01) {
    var clip = this.spec.clips[clipName];
    if (!clip) throw new Error('Unknown clip: ' + clipName);
    var self = this;
    var key = clipName;
    if (!this._scrubs[key]) this._scrubs[key] = [];
    if (!this._scrubs[key].length) {
      clip.tracks.forEach(function (track) {
        asArray(self._parts[track.part]).forEach(function (el) {
          if (!el.animate) return;
          var animation = self._animateElement(el, track.keyframes, Object.assign({}, track.timing, { fill: 'both', iterations: 1 }), PRIORITY.scrub, 'scrub');
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
  OgreAnimator.prototype._startFace = function (state, token) {
    var self = this;
    if (!state.face) return;
    function schedulePool() {
      if (token !== self._token) return;
      var clip = self._pickPool(state.face.pool);
      if (clip) self.play(clip, { priority: 'face', group: 'face', token: token }).catch(function () {});
      self._setTimer(schedulePool, self._randRange(state.face.holdMs || [4000, 6000]), 'face', token);
    }
    if (state.face.pool) schedulePool();
    else if (state.face.clip) this.play(state.face.clip, { priority: 'face', group: 'face', token: token }).catch(function () {});
  };
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
    this._cancelGroup('body'); this._cancelGroup('face'); this._cancelGroup('microlife'); this._cancelGroup('effects'); this._clearTimers('autoreturn');
    this._emit('statechange', { state: name });
    var self = this;
    function proceed() {
      if (token !== self._token) return;
      if (self._reducedMotion) { self._applyReducedState(state).catch(function () {}); return; }
      var chain = Promise.resolve();
      if (state.body && state.body.intro) chain = chain.then(function () { return self.play(state.body.intro, { priority: 'body', group: 'body', token: token }); });
      chain.then(function () {
        if (token !== self._token) return;
        if (state.body && state.body.loop) self.play(state.body.loop, { priority: 'body', group: 'body', token: token }).catch(function () {});
        self._startFace(state, token);
        self._startMicroLife(state, token);
        self._startEffects(state, token);
        if (state.autoReturn) self._setTimer(function () { self.setState(state.autoReturn.to); }, state.autoReturn.afterMs, 'autoreturn', token);
      }).catch(function () {});
    }
    if (oldState && oldState.body && oldState.body.outro) {
      var outro = this.spec.clips[oldState.body.outro];
      if (outro && outro.duration < 300) { this.play(oldState.body.outro, { priority: 'body', group: 'body', token: token }).then(proceed, proceed); return; }
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

  if (typeof window !== 'undefined') window.OgreAnimator = OgreAnimator;
  if (typeof module !== 'undefined' && module.exports) module.exports = OgreAnimator;
})();
