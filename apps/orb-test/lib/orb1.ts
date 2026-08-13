import { CAMERA_GLSL, NOISE_GLSL } from "./glsl";
import type { OrbGeometry, OrbSpec } from "./types";

/**
 * Orb 1 -- particleorb1.jpeg
 *
 * Reading the reference carefully, it is three things at once:
 *
 *  1. A BODY: a dense, dark charcoal dust sphere. Not a hollow ring. Thousands
 *     of near-neutral motes packed on the surface, each barely visible, summing
 *     additively into a solid grey ball.
 *  2. FILAMENTS: bright violet/white ribbons arcing across that body. They are
 *     made of the same dust -- a mote is bright because of WHERE it sits in a
 *     flow field, not because it belongs to a separate population.
 *  3. A RIM: the silhouette blows out, and bright dust puffs off the limb.
 *
 * The filament term is the load-bearing trick: pow(1 - abs(noise), k) lights
 * only the zero level-set of a noise field, which is a thin curved sheet. On a
 * sphere that reads as a ribbon arcing over the surface.
 */

const VERT = /* glsl */ `
precision highp float;

attribute vec3 a_base;
attribute vec4 a_rand;

uniform vec2  u_resolution;
uniform float u_time;
uniform float u_camDist;
uniform float u_fov;
uniform float u_flow;
uniform float u_size;
uniform float u_energy;

varying float v_bright;
varying float v_hue;

${NOISE_GLSL}
${CAMERA_GLSL}

void main() {
  vec3 dir = normalize(a_base);
  float shell = length(a_base);

  // How far past the skin a mote sits. Needed up here because the plume field
  // below acts on position, not just on brightness.
  float haloness = smoothstep(0.950, 1.005, shell);

  // The outer fringe is not a shell. The reference's 0.95-1.02 band has cv 1.010
  // and a k=5 harmonic at 0.773 of its own mean -- modulation that deep means
  // bright arcs with near-dark gaps between them, so the outer dust is thrown off
  // a few active regions rather than shed evenly. This render's halo was
  // isotropic by construction (the patch field is band-passed to the skin, and
  // the halo dim depends only on shell), so its only azimuthal variation was shot
  // noise: cv 0.452, amp 0.197.
  //
  // Frequency: a great circle is 2*pi long, so a field at frequency f puts about
  // pi*f features around it. k=5 wants f ~= 1.6.
  // Window centred on 0 so mean(wave) is 0.5. Simplex is bell-shaped about zero,
  // so the earlier -0.16..0.30 window sat above the distribution's centre and
  // averaged 0.42 instead -- which quietly took 7% off every radial bin, since
  // these factors are budgeted to average 1.
  // The arc count is anchored, not left to the noise. Tuning the frequency alone
  // (1.6 -> 1.45) moved the peak mode but could never hold it: pi*f is an AVERAGE
  // feature count, so each frame draws its own realisation, and sweeping the clock
  // the fringe peaked at k=4,3,8,2,7 on five frames while the reference holds k=5
  // in both outer bands (ring 0.430, fringe 0.773). A pure-noise field cannot fix
  // a mode; it can only make one likely.
  //
  // So the 5-fold term is explicit. atan gives azimuth in the screen plane, which
  // is the same angle the harmonic measurement sweeps, and fringe motes sit near
  // the limb where that is also their azimuth on the sphere.
  float az = atan(dir.y, dir.x);

  // Deliberately NOT a clean pentagon. The reference carries k=4 at 0.317 and k=6
  // at 0.125 alongside its k=5, so the arcs are uneven -- the ridge sets how MANY
  // there are and the noise makes them differ in width and strength. Weighted so
  // the ridge leads: +-0.55 against the simplex's effective +-0.42.
  // 0.72 against 0.48: at 0.55/0.60 the noise still outvoted the ridge and the peak
  // mode wandered k=5,4,4,5,2 over a clock sweep. The ridge has to lead clearly for
  // the count to hold, and the uneven-arc character survives because simplex at
  // 0.48 is still a third of the field.
  // 0.055 -> 0.50, set by arithmetic rather than by feel. In cos(5*az - t*d) the
  // PATTERN turns at d/5 rad/s, so the 0.055 above was 0.011 rad/s -- 0.6 degrees a
  // second, which is frozen. Every rate in this shader had the same problem, which
  // is why raising them 3.75x moved coherent motion by only a third. 0.50 gives
  // 0.1 rad/s, about 6 deg/s: an arc crosses its own width in a couple of seconds.
  float ridge = cos(5.0 * az + 1.3 - u_time * 0.50);

  // Drift slowed 0.05 -> 0.02. Active longitudes on a star are long-lived; the
  // eruption envelope below is what varies in time, so the pattern no longer needs
  // to slide to look alive, and holding it still is what lets a fixed mode read as
  // fixed rather than smearing across neighbouring harmonics.
  // 0.07 -> 0.35, on the same footing: features here are about 1/1.45 = 0.69 world
  // units across, so this is the rate at which the sample point crosses one, and
  // 0.35 crosses it in 2 s. At 0.07 it took ten.
  float plume = 0.72 * ridge + 0.48 * snoise(dir * 1.45 + vec3(4.1, 2.7 - u_time * 0.35, 8.9));
  // Window widened +-0.30 -> +-0.55 because the ridge roughly doubled plume's
  // spread (std about 0.54 now, against simplex's 0.35 alone). Left at +-0.30 the
  // smoothstep saturated to 0/1 across most of the sphere, which silently undid the
  // power law below -- pow() cannot skew a field that is already binary, so the
  // fringe fell back to two levels and cv dropped 1.017 -> 0.65..0.81. The window
  // has to track the field's spread to keep a real ramp for the exponent to bite
  // on. Still centred on 0, so mean(wave) is still 0.5.
  float wave = smoothstep(-0.55, 0.55, plume);

  // A near-binary cut of the SAME field for the fringe. The reference's outer
  // band has cv 1.010 -- variation as large as the mean -- which is not a
  // modulated shell but arcs with genuinely dark gaps between them. A soft ramp
  // cannot reach that however deep the mix, so the fringe gets a hard window.
  // Still centred on 0, so it still averages 0.5 and still costs no energy.
  // Scaled with the field like the window above, staying proportionally much
  // tighter -- this one is meant to be near-binary.
  float waveHard = smoothstep(-0.18, 0.18, plume);

  // What the fringe is actually shaped like. Walking the outer band spoke by
  // spoke, the reference reads p10=3.2 p50=32.0 p90=130.6 -- the top decile is
  // four times the median and 28% of azimuths are essentially dark. That is a
  // very skewed distribution, and waveHard cannot produce it: a 0/2 cut gives
  // two levels, so p90/p50 pins near 2 (measured 45.0/23.1 = 1.95) no matter how
  // deep the mix goes. A power law does: most azimuths land near zero, a few
  // near one, and the gain restores the mean so the halo's total energy -- and
  // therefore R -- is unchanged while its distribution is not.
  //
  // 6.2 was the measured gain at exponent 3.2. Taking the sprite fattening off
  // the halo (it was smearing a tail out to r=240) also filled the gaps back in
  // and cost cv 0.871 -> 0.711, so the contrast has to come from the exponent
  // instead of from coverage. The gain tracks it: measured 3.4 at p=2.4 and 6.2 at
  // p=3.2, i.e. roughly x1.8 per 0.8 of exponent, so p=3.8 wants about 9.7.
  float fringeArc = 9.7 * pow(wave, 3.8);

  // Which active region a mote belongs to, and when that region fires.
  //
  // The plume field alone gives the fringe its shape but it only DRIFTS -- every
  // arc sits at one brightness forever while the whole pattern slides sideways. A
  // star does not do that: individual active regions go off, throw material, and
  // subside while their neighbours are still quiet. So each region gets its own
  // clock, offset by a field at the same scale as the plumes, and they run
  // asynchronously. Sampled on dir, so the offset is fixed to a patch of sphere
  // rather than to a mote -- neighbours erupt together, which is what makes it
  // read as one region letting go instead of as noise.
  // Two separate things are being set here and they were conflated once already.
  //
  // The CYCLE SPAN (below) is what decorrelates regions in time. At 0.5 of a cycle
  // over ~3 coarse patches, most of the sphere sat inside one rise-and-decay of
  // everything else: the fringe pulsed nearly as a unit and the outer band mean
  // swung 27 -> 102 across a clock sweep against the reference's steady 52.2.
  //
  // The FREQUENCY is what decides whether the eruptions reinforce the arcs or fight
  // them, and 2.1 fought them. It puts about pi*2.1 = 6.6 patches around a great
  // circle, so it stamped its own k~6-7 modulation across the ridge's 5, and the
  // measured peak slid to k=4 or k=2 depending on how the two happened to align --
  // cv decayed monotonically 0.833 -> 0.626 over the sweep, which is the signature
  // of interference rather than of noise. 1.45 matches the plume's own scale, ~4.5
  // patches for 5 arcs, so each arc gets roughly one phase and fires as a unit.
  // Aligning the fields is what lets the eruption deepen k=5 instead of masking it.
  float phase = snoise(dir * 1.45 + vec3(53.2, 17.8, 31.4));

  // Eruption envelope: fast rise, long decay -- the shape of a flare, not a sine.
  // fract() supplies the cycle, the smoothstep gives it a finite rise so the wrap
  // is not a visible pop, and the exponential is the decay. Divided by its own
  // mean (0.30 for these constants) so a surging fringe carries the same
  // TIME-AVERAGED energy as the steady one it replaces: the radial profile and R
  // stay where they were measured and only the distribution over time changes.
  // x1.6 spreads simplex's roughly +-0.7 across a full cycle and past it; fract
  // wraps, so overshoot costs nothing and only decorrelation is gained.
  // 0.045 -> 0.13. At 0.045 a region's full rise-and-decay took 22 s, so over any few
  // seconds of watching almost no flare completed -- the eruptions were present in
  // the metrics and too slow to see. 0.13 gives a 7.7 s period, and with the decay
  // above a region is visibly bright for about 2 s.
  float cyc = fract(u_time * 0.13 + phase * 1.6);

  // Normalised to PEAK 1, not to mean 1. The mean-1 form ran to 2.33 at the crest,
  // and every consumer below feeds it to mix(), which extrapolates rather than
  // clamps: the arcs went to 1.73x their calibrated ceiling and the radial throw
  // to 2.33x, which put world shells at 1.27 and inflated R from 223 to 239 with
  // a tail still reading 19.6 at r=250 against the reference's 3.7. Bounded to
  // [0,1] the mixes interpolate, so each consumer's maximum is exactly the value
  // the radial profile was calibrated against. Mean is then 0.43, and every
  // consumer carries its own compensation for that.
  // Decay 3.0 -> 1.8, which is a duty-cycle fix rather than a shape preference.
  // exp(-3c) leaves surge appreciable over only about the first fifth of a cycle,
  // so with ~7 coarse patches on the visible hemisphere the expected count of
  // active regions was ~1.4 -- and an expectation of 1.4 means frames with zero.
  // That is measurable: halving the resting floor scaled t17's p10 by 0.877 and its
  // p90 by 0.861, near-uniformly, which only happens if every azimuth shared one
  // resting multiplier. Nothing was erupting on that frame, so the arcs sat at the
  // floor together and the band read flat (cv 0.587, 6.7% dark) while t2 with two
  // regions lit reached 0.918 and 31.7%. exp(-1.8c) holds surge above half out to
  // cyc 0.4, so ~3 regions are lit at any time and the count no longer collapses.
  // Peak is then 0.807 near cyc 0.125 (smoothstep already at 1, exp not yet down),
  // so /0.81 keeps the peak-1 normalisation every mix() below depends on.
  float surge = clamp(smoothstep(0.0, 0.12, cyc) * exp(-1.8 * cyc) / 0.81, 0.0, 1.0);

  // mix, not a bare multiply. At rest a region still shows its arc and only the
  // eruption takes it to full; multiplying outright would blink the fringe out
  // between flares, which reads as flicker rather than as material being thrown.
  //
  // Floor 0.60 -> 0.30. Walking the outer band spoke by spoke, a quiet frame had
  // only 5.8% of azimuths dark against the reference's 28.1% -- the gaps were
  // filling in between eruptions, which is what held cv at 0.559 there while an
  // active frame reached 0.858. The reference keeps its gaps dark whatever else is
  // happening, so the resting level has to sit near the floor rather than at 60%.
  // /0.654 restores the mean the gain above was calibrated for. The slower decay
  // above raises surge's own mean 0.43 -> 0.506, so this factor now averages
  // 0.30 + 0.70*0.506 = 0.654. The divisor has to track that: it is arithmetic, not
  // a tuning knob, and leaving it at the old value would quietly rescale the band.
  fringeArc *= mix(0.30, 1.0, surge) / 0.654;

  // Interior lobes, a separate and much coarser field. The reference's harmonic
  // spectrum splits cleanly by radius: k=2 dominates the INTERIOR (0.401 at
  // 0.50-0.70 R, 0.511 at 0.70-0.85) while k=5 owns the ring and fringe (0.430,
  // 0.773). This render had it inverted -- k=2 of 0.482 at the ring and 0.026 in
  // the interior -- because the patch field is masked to the skin and nothing
  // modulated the body at all. Frequency 0.62 puts about pi*0.62 = 2 features
  // around a great circle.
  // Drift 0.03 -> 0.004, for the same reason the ridge above was slowed. At ~2
  // features per sphere a single lobe covers most of the visible face, and lobeW
  // below spans 0.30..1.70 -- so drifting the field swings the entire interior as a
  // unit. Measured: r=50 read 117.3 on one frame and 47.1 on another, a 2.5x swing
  // against the reference's steady 65.8, and the ratio is lobeW's own range. This
  // was misdiagnosed as advection first; narrowing the churn swing changed the
  // interior by under a digit, which is what ruled it out and pointed here.
  //
  // The tension is real and this is the resolution: the reference genuinely needs
  // k=2 in the interior (0.401 at 0.50-0.70 R, 0.511 at 0.70-0.85), and nothing but
  // a ~2-feature azimuthal field supplies that. But a k=2 pattern only has to sit
  // there to be measured -- it does not have to move. Held nearly still it gives the
  // harmonic with a fixed mean bias, which the 1.34 below already compensates, and
  // the eruption envelope supplies the time variation instead.
  float lobe = snoise(dir * 0.62 + vec3(19.4, 6.1 + u_time * 0.004, 2.8));

  // NOT run through a smoothstep, unlike the two above. Centring a window on
  // zero only averages 0.5 if the field itself averages zero over the domain,
  // and at ~2 features per sphere a single realisation has a real mean bias --
  // which a smoothstep then saturates into a large one. That took every interior
  // bin down about 25% (bin 0 read 49.9 against 82.7) purely as a side effect of
  // adding structure. The linear form leaves the bias proportional and small.
  // Amplitude 0.9 -> 0.45 (range 5.7x -> 2.6x), and this one is a deliberate trade
  // rather than a straight fix.
  //
  // The interior swings 49.5 to 115.6 at r=50 across the frame sweep against the
  // reference's steady 65.8, and the cause is not this field moving -- it is
  // rotY(u_time * 0.07) turning the orb past it. The field is fixed in object space
  // and has only ~2 features on the whole sphere, so rotation brings a bright lobe
  // to face the camera on one frame and a dim one on the next, and the visible
  // hemisphere's mean rides that ratio. Slowing the field's own drift to 0.004
  // changed nothing, which is what identified rotation as the mechanism.
  //
  // The trade: this same field is the only source of the interior k=2 the reference
  // needs (0.401 at 0.50-0.70 R, 0.511 at 0.70-0.85), so the amplitude cannot go to
  // zero. Halving it should take the swing to about 1.5x and costs perhaps a third
  // of the k=2 amplitude. A whole-orb brightness pulse is the worse artifact of the
  // two: it is visible as motion, where a low k=2 is only visible in a measurement.
  // Frequency is what would fix both, but raising it destroys k=2 by definition.
  //
  // Compensation below moves with it: 1.34 implied mean(lobeW) = 0.746, i.e.
  // mean(lobe) = -0.282 over the visible set, so at 0.45 the mean is 0.873 and the
  // factor is 1.145.
  float lobeW = clamp(1.0 + 0.45 * lobe, 0.55, 1.45);

  // The plume field lights the skin too. The reference peaks at k=5 in BOTH its
  // ring band (amp 0.430) and its fringe (0.773), which says one large-scale field
  // decides where dust is active: it brightens the skin in arcs and throws the
  // plumes off those same arcs. Modulating them independently gave the ring k=2
  // from the patch field while the fringe read k=5.
  float skinness = smoothstep(0.926, 0.939, shell) * (1.0 - smoothstep(0.958, 0.978, shell));

  // Everything inside the skin. The body is what carries the k=2, so this has to
  // run right up to the skin's own start: tapering it from 0.86 left the shells
  // that project to 0.70-0.85 R barely modulated, and that band's k=2 fell to
  // 0.045 against the reference's 0.511 even as the band inside it rose.
  float innerness = 1.0 - smoothstep(0.925, 0.945, shell);

  // Curl advection. Sampled on the sphere direction so neighbouring motes share
  // a streamline and drift together rather than each wandering off alone.
  //
  // Two scales, not one. A single field at 1.5 gives the whole body the same
  // slow uniform drift -- everything sliding one way together, which reads as the
  // sphere rotating rather than as anything happening inside it. Convection has a
  // coarse overturning circulation with faster granular churn riding on top, so
  // the second octave runs at ~3x the frequency and ~4x the time rate at a third
  // of the amplitude. Their time offsets are unrelated, so the two never lock
  // into a single apparent motion.
  // Time rates 0.04 -> 0.15 and 0.155 -> 0.30. This is the coherent-flow control
  // and it was the thing actually missing.
  //
  // Differencing two frames 0.25 s apart and pre-blurring before the difference
  // separates flow from flicker: raw delta was 0.638 of the mean, but at an 8 px
  // blur only 0.064 survived. So 90% of the change was sub-3 px twinkle -- motes
  // popping through the spark dither -- and the structure itself was nearly static.
  // That is why it reads unagitated despite two thirds of the brightness turning
  // over every quarter second: the eye tracks coherent motion and ignores fizz.
  //
  // Only the DIRECTION of curl survives the pos rebuild, so this term slides motes
  // laterally across the sphere; travel sets how FAR and these rates set how FAST.
  // Rate is the free variable: every calibrated still-frame number (radial profile,
  // harmonics, cv, R) is an expectation over the noise field, and changing how fast
  // the field is traversed only draws a different sample from the same distribution.
  // Amplitude would not be free -- that re-clumps and moves energy between bins.
  // 0.15 -> 0.45 and 0.30 -> 0.55, by the same crossing-time argument: features are
  // 1/1.5 and 1/4.4 world units, so these cross one in 1.5 s and 0.4 s respectively.
  // Coarse flow the eye can follow, fine churn riding on top of it.
  vec3 curl = curlNoise(dir * 1.5 + vec3(0.0, u_time * 0.45, 0.0))
            + 0.34 * curlNoise(dir * 4.4 + vec3(6.2, 1.7 - u_time * 0.55, 12.8));

  // Erupting regions churn harder than quiet ones, and only inside the skin --
  // the fringe already has its own radial throw above, and doubling the advection
  // out there would drag the plumes sideways off the arcs that threw them.
  float travel = u_flow * (0.04 + 0.07 * a_rand.w) * (0.6 + 0.8 * u_energy)
  // Reverted to the calibrated 0.75..1.9. Narrowing this to 1.02..1.47 was an
  // attempt to damp the interior radial swing and it moved r=50 by less than one
  // digit (117.3 -> 117.3, 46.8 -> 47.1), which is what proved the swing was the
  // lobe field's drift rather than advection amplitude. Kept wide because this is
  // the term that actually reads as an erupting region churning harder than a quiet
  // one, and it is per-region rather than global.
               * mix(1.0, mix(0.75, 1.9, surge), innerness);
  vec3 pos = dir * shell + curl * travel;

  // Re-shell: let curl slide motes ACROSS the sphere without inflating it.
  //
  // Pinning every mote back onto its own shell is what keeps the silhouette a
  // clean circle, which is right for the body and wrong for the fringe -- so the
  // pin is relaxed on the halo and the plumes carry their motes outward, letting
  // the outline itself wave instead of only brightening in bands.
  // Only the DIRECTION of this survives: pos is rebuilt from fdir further down,
  // after the patch field has decided which motes spark. So the pin sets how far
  // curl may slide a mote around the sphere, and nothing at this point can change
  // a mote's radius. Raising a radial term here was a silent no-op for exactly
  // that reason -- the outer band did not move a digit.
  float pin = mix(0.88, 0.34, haloness);
  pos = normalize(pos) * mix(length(pos), shell, pin);

  // Radial push for the fringe, consumed where pos is rebuilt.
  //
  // Brightness modulation alone tops out near cv 0.60 against the reference's
  // 1.010 and cannot do better: the halo is a continuum in radius, so darkening
  // one azimuth still leaves that annulus populated by the shells either side of
  // it. The outline itself has to move. Biased INWARD (mean -0.02) rather than
  // outward, because the halo's ceiling is also its reach: pushing plumes past
  // 1.10 is what previously drew a tail 30 px past the end of the object, so the
  // gaps pull in hard and the plumes barely move.
  // The surge term rides the outward half only. An erupting region throws its
  // material out and lets it fall back; the quiet gaps between regions should not
  // breathe in sympathy, so only the push is modulated.
  //
  // Both constants moved when surge was introduced, and they had to. surge has
  // mean 0.43, so gating the outward term with it took the push's mean from
  // 0.080*0.5 - 0.058 = -0.018 to -0.041 -- the halo was being hauled inward on
  // average, which is why R fell 223 -> 214..219 across the frame sweep and the
  // tail at r=230 dropped to 8.6 against the reference's 29.2. 0.125 and -0.045
  // restore the mean to -0.018 exactly while leaving the peak excursion finite,
  // so the fringe reaches further DURING an eruption than the steady version ever
  // did without sitting there between them.
  // -0.045 -> -0.050 for the slower decay. wave and surge are independent fields,
  // so mean(wave*surge) = 0.5*0.506 = 0.253, and the old inward term left the push
  // averaging -0.013 instead of the calibrated -0.018. That single digit is what
  // drove BOTH regressions in the last sweep: a less-inward halo carried material
  // out of the 0.95-1.02 annulus, so R rose 223 -> 226..229 and the band mean fell
  // to 30.1 at the same time. Same cause, so one correction covers both.
  // Peak 0.100 -> 0.075, inward bias -0.0433 -> -0.0465 (mean push -0.0275).
  // Sharpening the arcs and pushing R out are the same event seen twice: fringe cv
  // rose to 1.112 and R went 225 -> 228..230 together, because a more contrasted
  // fringe puts more energy in the few bright azimuths and R is the 97%-energy
  // radius, i.e. a property of the tail. The reference holds cv 1.010 AND R 223 at
  // once, so the arcs are right and reaching too far. Trimming the ceiling also
  // helps the edge span, which had run to 50 px against the reference's 38.
  float fringePush = 1.0 + haloness * u_flow * (0.075 * wave * surge - 0.0465);

  vec3 fdir = normalize(pos);

  // NOT a level set. pow(1 - abs(noise), k) lights the field's zero sheet, and a
  // smooth field's zero sheet intersected with a sphere is generically a set of
  // CLOSED curves -- loops. So that construction cannot draw anything but a net
  // of cells, which is exactly the honeycomb this rendered for several passes.
  // Thinning the sheet, retuning the frequency and masking it to the skin all
  // left the cells intact, because the cells were the geometry, not a artefact
  // of the tuning.
  //
  // The reference has no loops. It has broad irregular PATCHES of lit dust with
  // charcoal between them, so this thresholds the field itself rather than its
  // zero crossing. Two octaves at close frequencies keep the patch borders
  // ragged instead of smoothly elliptical.
  // The offsets matter. Simplex has its gradient lattice aligned to the axes,
  // and at this frequency the sphere only spans a couple of cells, so sampling
  // centred on the origin put a lattice node at the middle of the disc and drew
  // a visible axis-aligned cross. Sampling well off-lattice breaks that up; the
  // axes/diagonals metric reads 0.998 against the reference's own 1.050, so the
  // frequency can come back down without the cross returning.
  //
  // Frequency is set by the ANGULAR HARMONIC content of the reference, not by
  // eye. Decomposing its limb bands around the azimuth puts the energy in k=2
  // and k=5 at amplitude 0.4-0.77: a handful of big bright arcs separated by
  // big dark gaps. At 1.90/3.60 this rendered k=14 at 0.35 -- many small evenly
  // spaced blobs, the necklace. So the patches want to be FEWER and LARGER.
  //
  // Dropping the frequency brought the cross straight back (axes/diagonals
  // 0.743, i.e. bright diagonal lobes with dark axes between) because constant
  // offsets only move where lattice nodes LAND -- the lattice axes still point
  // along x/y/z, and at this frequency the sphere spans only a couple of cells,
  // so its orientation is the visible feature. Each octave therefore gets its
  // own tilted, near-orthonormal basis: the sphere is barely distorted, no axis
  // survives, and the two octaves cannot reinforce each other's residue.
  vec3 q1 = vec3(
    dot(fdir, vec3( 0.63,  0.62,  0.47)),
    dot(fdir, vec3(-0.71,  0.36,  0.60)),
    dot(fdir, vec3( 0.31, -0.70,  0.65))
  );
  vec3 q2 = vec3(
    dot(fdir, vec3( 0.44, -0.55,  0.71)),
    dot(fdir, vec3( 0.79,  0.61,  0.02)),
    dot(fdir, vec3(-0.43,  0.57,  0.70))
  );

  float n1 = snoise(q1 * 1.20 + vec3(11.3, 4.7 + u_time * 0.05, 19.1));
  float n2 = snoise(q2 * 2.45 + vec3(31.7 - u_time * 0.035, 7.9, 2.3 - u_time * 0.02));
  // Narrower window than the old (0.02, 0.58): the reference's azimuthal
  // coefficient of variation at the limb is 1.010 against 0.645 here, so the
  // patches also need harder borders -- lit and unlit, less halfway.
  float fil = smoothstep(0.04, 0.46, n1 * 0.78 + n2 * 0.32);

  // Patches are a SURFACE feature. Interior motes share a direction with the
  // skin motes in front of them, so an unmasked patch is drawn once per depth
  // along the ray: concentric copies of the same shape, and a violet tint over
  // the charcoal body since hue rides the same term. The skin starts at 0.970
  // and the interior tops out at 0.955, so this cuts between the two
  // populations rather than fading across them.
  // Band-passed, not just high-passed. shell > 1 is the halo, and a plain
  // smoothstep leaves it at fil = 1, so every patch got a second dimmer copy
  // printed outside the limb. The halo is meant to be featureless dust.
  // Tracks the skin, which moved to 0.938-0.954 once the raw pixel profile
  // showed the body was oversized. These two windows are the skin's own span:
  // patches are a skin feature and must not print on the halo outside it.
  fil *= smoothstep(0.926, 0.939, shell) * (1.0 - smoothstep(0.958, 0.978, shell));

  // Per-mote dither. Inside a lit patch the reference is a scatter of
  // individually resolvable bright specks with charcoal showing between them,
  // not a smooth glow. So the patch field sets the PROBABILITY that a mote
  // fires rather than how brightly every mote in the patch glows -- motes that
  // lose the dither stay ordinary body dust. This is what lets the patch field
  // be broad without the face turning into a violet smear.
  // Trimmed with the patch window: narrowing the smoothstep raised fil's mean,
  // which raised the fraction of motes firing at fixed gain and took the hot
  // pixel fraction to 15.8% against the reference's 9.5%.
  float spark = step(a_rand.x, fil * 0.52);

  // Bright dust lifts off the surface -- the puffs at the limb in the reference.
  // Gated on spark, not on fil: lifting every mote in a patch inflates whole
  // regions of the silhouette, which read as a puffball rather than as loose
  // dust thrown off where the bright material breaks the edge.
  // This is the ONLY place a mote's final radius is decided -- everything radial
  // computed above is discarded here, so fringePush has to be applied at this
  // line to have any effect at all.
  pos = fdir * (shell * fringePush + spark * 0.035 * u_flow);
  // Spin 0.07 -> 0.16 rad/s, about 9 deg/s. Kept the slowest rate on the object: it
  // is the one motion that is rigid, so it reads as the body turning rather than as
  // material moving, and it is also what sweeps object-space fields past the camera
  // and swings the interior bins.
  pos = rotY(u_time * 0.16) * rotX(-0.16) * pos;

  vec3 n = normalize(pos);
  float facing = abs(n.z);

  // Halo dim. a_rand.z was doing this job and could not: it scales ONLY the
  // sparkle term below, and halo motes never spark (fil is now zero out there),
  // so scaling it changed nothing at all -- the outer band stayed at 92.1 while
  // the reference falls to 52.2. The body term is what the halo is made of, so
  // the attenuation has to land there. Driven off shell rather than a new
  // attribute: the halo is exactly the population above 1.0 by construction.
  // 0.30 was far too dim to do the job it exists for. R is the 97%-ENERGY radius,
  // so a population can only push it outward in proportion to the energy it
  // carries: at 3.3% of motes times 0.30 brightness the halo held about 1% of the
  // total, and R did not move (222 -> 221) even after its reach went out to 1.135.
  // Projection arithmetic for the target: f = 1/tan(fov/2) = 2.019 at camDist
  // 2.95, so a shell s silhouettes at NDC = f*s/sqrt(d^2-s^2). World 0.98 lands at
  // 213 px of 600. For that ring to sit at 0.90 R, R must be 237 px, which is
  // world 1.075 -- so 3% of ALL energy has to lie beyond 1.075, and with the halo
  // spanning 1.00-1.135 that means the halo itself needs ~6% of the total.
  // Halo motes light their own silhouette and go nearly dark face-on. A shell
  // projects onto the WHOLE disc, not just its rim -- 56% of a uniform shell's
  // motes land inside 0.9 of its own radius -- so raising the halo enough to
  // reach r=230 also laid a pedestal across the body and took the interior from
  // ~72 to ~85 against the reference's ~72, while r=230 only needed to go from
  // 4.5 to 29. The 1/facing pile-up alone is not a steep enough concentration.
  // The body term leans the opposite way (brightest at facing=1) because the
  // body IS the disc; this population is only ever an edge.
  float haloEdge = mix(1.0, pow(1.0 - facing, 2.0), haloness);

  // The falloff outside the ring. The reference drops from 93 at r=210 to 29 at
  // r=230, so this population is real but steep -- hence a ramp keyed to how far
  // past the skin a mote sits, rather than the flat step this used to be.
  // Floor raised 0.22 -> 0.60 because 0.22 put the far tail at raw-radial 4.5,
  // below profile.py's own <6 cutoff, so it was excluded from the energy
  // integral entirely and could not move R no matter how far it reached. The
  // ramp now runs to 1.03 instead of 1.010 so the dimming tracks the longer
  // halo rather than bottoming out in its first sixth.
  // The ramp reaches its floor at 1.000 rather than 1.030 because the excess was
  // worst just outside the ring -- r=220 read 83.6 against 65.9 while r=230 read
  // 34.3 against 29.2 -- and shells 0.954..1.000 are exactly what lights r=209..219.
  // Ramping to 1.030 left that near band at 0.83 of full brightness.
  // The plume field gates brightness as well as position. The gain is set so the
  // mean stays near 1 (wave averages ~0.5, and 0.16 + 1.68*0.5 = 1.0), because
  // the radial profile and R are already matched -- this redistributes the halo's
  // energy around the azimuth rather than adding any.
  float haloDim = mix(1.0, 0.55, smoothstep(0.954, 1.000, shell))
                * haloEdge
                // The fringe's own distribution, replacing the 0/2 binary cut.
                * mix(1.0, fringeArc, haloness)
                // Ring arcs, same field, soft cut. The reference's ring harmonic
                // is 0.430 against the fringe's 0.773, so the ring is modulated
                // hard but not to black.
                * mix(1.0, 0.10 + 1.80 * wave, skinness)
                // Interior k=2. Kept shallow: the reference's interior cv is
                // 0.409-0.550, well below the fringe's, so this is a broad
                // brightness imbalance across the body, not arcs.
                // The 1.34 is a measured compensation, not a taste call. This
                // realisation of the lobe field runs negative-mean over the
                // sphere, so the factor averages ~0.75 rather than 1 and pulled
                // the interior bins from ~70 down to ~50 while leaving the ring
                // (which innerness excludes) untouched. Correcting it globally
                // would have blown the ring out instead.
                * mix(1.0, lobeW * 1.145, innerness)
                // Eruptions glow through the body, not just stir it. Shallower
                // than the fringe's swing (0.85..1.0 against 0.60..1.0) because
                // the reference's interior cv is 0.409-0.550: the body is a broad
                // soft imbalance, and a deep flare here would read as the whole
                // orb pulsing. /0.9259 for surge's 0.506 mean, so the interior
                // bins stay where the radial profile put them.
                * mix(1.0, mix(0.85, 1.0, surge) / 0.9259, innerness);


  // Rim. Thin: at exponent 4.5 this painted a wide annulus that swallowed the
  // body in blown-out speckle.
  float rim = pow(1.0 - facing, 6.0);

  // The reference limb is NOT a uniform bright ring -- it fires in a couple of
  // arcs and goes nearly dark between them. This term stays SMALL. rim depends
  // only on |n.z|, so it is perfectly uniform around the silhouette and all of
  // its variation has to come from fil; at a high gain that turned the edge into
  // an evenly-spaced necklace of blobs, because the patch field is roughly
  // periodic around a great circle. The reference's edge glow is mostly just a
  // face patch seen at grazing angle, where the skin's projected density piles
  // up on its own, so the explicit rim only needs to nudge it.
  float limb = rim * (0.015 + 0.22 * fil * spark);

  // Face brightness outweighs the limb term. The reference's bright regions
  // cross the middle of the disc; when the limb dominates, everything bright
  // migrates to the silhouette and the face empties out.
  float hot = spark * (0.55 + 0.95 * fil) + limb;

  // Fake key light so the body has a gradient instead of reading flat.
  float key = 0.55 + 0.45 * dot(n, normalize(vec3(-0.45, 0.55, 0.4)));

  // Back hemisphere sits behind the dark body -- dim it. There is no depth test.
  float depth = smoothstep(-1.0, 1.0, n.z);
  float backSide = mix(0.42, 1.0, depth);

  // The body term is what makes this a sphere rather than a ring: every mote
  // contributes a little and additive blending sums them into charcoal dust.
  // It is deliberately dim -- the reference body is matte charcoal, and the
  // count is what fills it in. Turning this up produces grey haze, not dust.
  // Per-mote alpha MUST stay well under 1. Additive blending clips each sprite
  // core to white once alpha reaches 1, which turns every colour in the palette
  // into the same white speck -- the body went pale and the violet vanished
  // even though the integrated radial luma matched the reference exactly.
  // Brightness is kept low and the count carries the density instead.
  // 1.50 sat ~15% over the reference once the interior became a shell (mean
  // luma 89.7 against 77.1), the shell being a more efficient use of the same
  // mote budget than the volume fill it replaced.
  // PARTIAL cancellation, not exact. A shell's projected mote density goes as
  // 1/facing, so weighting by facing^1 cancels it dead flat -- but then the only
  // limb structure left is the constant floor, which multiplies that same 1/facing
  // and diverges right at the silhouette. That combination gave a flat face with
  // a divergent hairline at the very edge: band 0.85-0.95 measured 69.5 and
  // 0.95-1.02 measured 73.8, where the reference runs 96.6 then falls to 52.2.
  //
  // Transfer function: weight = floor + a * facing^p, so brightness = weight *
  // (1/facing) = floor/facing + a * facing^(p-1). That is MONOTONIC in facing for
  // any p -- rising toward the limb when p < 1, falling from the disc centre when
  // p > 1. Neither can put a maximum in the middle, so no choice of p here draws
  // the reference's ring: its 0.85-0.95 band (96.6) sits above BOTH neighbours
  // (78.7 inside, 52.2 outside). The exponent only sets how the face leans.
  //
  // The ring is a GEOMETRY feature, not a shading one: it is the projected
  // pile-up of the skin shell at its own silhouette, with near-nothing beyond it
  // to fill the band outside. So p stays slightly under 1 for a gentle limb lean
  // and the ring is bought by concentrating the skin and starving the halo.
  float body = 1.15 * key * (0.06 + 0.94 * pow(facing, 0.55));

  // Sparkle (a_rand.z) rides ONLY the filaments. Applied to the body it dusts
  // the whole face with white speckle, which is what made the last pass read as
  // noise rather than as a smooth surface.
  v_bright = (body * haloDim + 0.62 * hot * a_rand.z) * backSide * (0.7 + 0.6 * u_energy);

  // Hue rides the same term: ash where the dust is cold, violet -> white where
  // the filaments and rim fire. The gain is higher than the brightness gain
  // because the thin filament sheet makes hot small, and the per-mote jitter is
  // kept tiny on purpose -- at 0.16 it alone pushed every background mote a
  // third of the way to violet, tinting the whole body instead of leaving it
  // charcoal.
  // 2.4 was too much gain: it drove ordinary filament motes straight past the
  // violet and blue bands into the white one, so the ribbons rendered as plain
  // white. Only the hottest cores should clip to white.
  // 0.62 overshot the other way round the colour metric -- 62.2% of lit pixels
  // strongly violet against the reference's 45.8%, and saturation 0.354 against
  // 0.295. The body should read charcoal with violet ON it, not violet through.
  // No a_rand.x jitter here any more: that channel now drives the spark dither,
  // so adding it to the hue would correlate the two -- every mote that fired
  // would also be the one pushed least toward violet.
  v_hue = clamp(hot * 0.50 + a_rand.w * 0.05, 0.0, 1.0);

  // Filament motes are drawn larger as well as brighter, which is what keeps
  // the ribbons legible now that the sheet itself is thin.
  // The far halo is drawn with fat faint motes instead of more small ones.
  // What the outer profile measures is mean luma over an annulus, i.e. coverage,
  // and coverage goes as count x sprite AREA -- so 3x the sprite buys 9x what 3x
  // the count buys, and costs no motes taken off the body. Reaching further did
  // nothing on its own for exactly this reason: extending the halo to world 1.15
  // put motes at r=250 but only ~4.6k of them in the r=225-235 annulus, which at
  // a 1.4 px sprite covers a quarter of it and reads 5.4 against the reference's
  // 29.2. It also reads as smooth glow rather than resolvable specks, which is
  // what the reference shows outside r=220.
  // Ramp top tracks the halo's own ceiling (now 1.052) rather than sitting past
  // it, and the gain drops 5.0 -> 3.0. Nothing is seeded beyond 1.052, which
  // projects to 231 px, yet r=240 was reading 27.7 against the reference's 7.2 --
  // that tail is not reach, it is sprite smear: a mote 6x oversized paints well
  // outside its own centre. The arc distribution now supplies the brightness that
  // the fat sprites used to, so the coverage can come off.
  float haloFat = 1.0 + 3.0 * smoothstep(0.980, 1.052, shell);
  float size = u_size * a_rand.y * haloFat * (0.9 + 0.9 * hot);
  gl_PointSize = projectPoint(pos, size, u_resolution, u_camDist, u_fov);
}
`;

const FRAG = /* glsl */ `
precision mediump float;

varying float v_bright;
varying float v_hue;

void main() {
  // Round sprite with a soft shoulder -- dots with a faint halo, not hard discs.
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = dot(uv, uv);
  if (d > 1.0) discard;

  float core = 1.0 - smoothstep(0.0, 0.5, d);
  float halo = (1.0 - smoothstep(0.0, 1.0, d)) * 0.38;
  float alpha = (core + halo) * v_bright;
  if (alpha < 0.003) discard;

  // ash -> violet -> pale blue -> white. No warm tones anywhere in the source.
  //
  // ash is the colour of UNLIT body dust, which is most of the sphere, so it
  // alone sets the baseline of the violet metric. At (0.255, 0.240, 0.430) its
  // blue-green gap was 0.19, i.e. 48/255 -- already double the metric's
  // "strongly violet" threshold of 25 -- so every body mote counted as violet
  // and the fraction stayed pinned near 65% against the reference's 45.8%
  // however far the v_hue gain was cut. Near-neutral charcoal with a slight cool
  // cast keeps the dust under the threshold and lets the lit bands carry the
  // violet, which is what the reference actually looks like: charcoal with
  // violet ON it, not violet throughout.
  // Solved rather than guessed: the metric counts a pixel violet when b-g > 25
  // of 255, and an unlit mote's gap scales with its luma, so ash's hue fixes the
  // luma above which body dust counts. The capture's lit-pixel luma at the 45.8th
  // percentile is 72.7, so the gap must cross 25 exactly there, i.e.
  // (b-g)/mean(ash) = 0.344. b = 0.372 gives 0.343.
  vec3 ash    = vec3(0.270, 0.268, 0.372);
  vec3 violet = vec3(0.545, 0.310, 0.960);
  vec3 blue   = vec3(0.510, 0.660, 1.000);
  vec3 white  = vec3(0.960, 0.960, 1.000);

  vec3 c = mix(ash, violet, smoothstep(0.02, 0.42, v_hue));
  c = mix(c, blue, smoothstep(0.42, 0.68, v_hue));
  c = mix(c, white, smoothstep(0.68, 0.97, v_hue));

  gl_FragColor = vec4(c * alpha, alpha);
}
`;

function build(targetCount: number): OrbGeometry {
  const count = targetCount;
  const base = new Float32Array(count * 3);
  const rand = new Float32Array(count * 4);

  // Deterministic PRNG (mulberry32) so a reload reproduces the same cloud.
  let s = 0x9e3779b9;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < count; i++) {
    // Even sphere sampling. Naive lat/long would clump at the poles.
    const u = rnd() * 2 - 1;
    const phi = rnd() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));

    // Nearly everything sits in a thin skin. That skin IS the body: filling the
    // volume evenly would wash the dark centre out to uniform grey.
    const t = rnd();
    let shell: number;
    if (t < 0.30) {
      // Skin. Gives the crisp silhouette and carries the filaments.
      //
      // This is where the ring comes from, and it only works if the skin is
      // SEPARATED from the shell below it. A shell's projected density diverges
      // at its own silhouette (1/sqrt(1-r^2)), so a thin skin at radius R draws a
      // bright annulus just inside R. When the skin ran 0.955-0.987 and the inner
      // shell ran 0.74-0.955 the two were contiguous -- one solid body out to
      // 0.987 whose pile-ups smeared across every radius it covered, which is why
      // the outer half of the profile came out flat (79.8 then 76.5) instead of
      // peaked (96.6 then 52.2). Narrow, and with a gap under it, the pile-up
      // lands in one band.
      //
      // WHICH band is set by this radius against the profile's normalisation, and
      // that is computable rather than a guess. The metric's R is the 97%
      // luma-energy radius; the camera (camDist 2.95, fov 0.92) projects world
      // radius 1.0 to 217px of the 600px analysis frame, and R measures 222px, so
      // R corresponds to world radius ~1.023. A skin at 0.988 therefore piles up
      // at 0.988/1.023 = 0.966 R -- inside the OUTERMOST band, which is why that
      // band came out brightest (96.2) when the reference has it darkest (52.2).
      // That reasoning fails on one point, and the failed run is worth recording:
      // R is MEASURED from the image, so it tracks the brightest material rather
      // than staying fixed. Pulling the skin in to 0.918 dragged R down with it
      // (222 -> 209 px) and the ring stayed at ~0.96 R. The shell's radius cannot
      // set the ring's position in R units.
      //
      // What actually positions it is how far the DIM material reaches past the
      // bright shell, since that is what pushes the 97%-energy radius outward. So
      // the skin belongs at the silhouette, and the halo below carries the ratio.
      // Solved, not guessed. A raw pixel-radius profile (rather than an
      // R-normalised one, which hides size errors because it rescales them away)
      // puts the reference's ring peak at r=205 px of 600 and this render's at
      // r=215, with BOTH images measuring R=223. So the brightness ratios were
      // never the defect: the body is simply ~5% too big, which slid the ring
      // from 0.92 R into the outermost band.
      //
      // Inverting the projection for a 205 px ring: NDC = 205/300 = 0.683 and
      // NDC = f*s/sqrt(d^2 - s^2) with f = 2.019, d = 2.95, so s^2 = 0.894 and
      // s = 0.946. Hence 0.938-0.954 rather than 0.972-0.988.
      shell = 0.938 + rnd() * 0.016;
    } else if (t < 0.873) {
      // Inner shell, NOT a filled volume.
      //
      // This was a volume fill (pow(rnd(), p) * 0.955) back when the body term
      // was unweighted, because a bare shell projects as 1/sqrt(1-r^2) -- it
      // starves the middle of the disc and piles up at the limb -- and a volume
      // projects as sqrt(1-r^2), so the two were meant to cancel.
      //
      // The body term now carries a facing weight, which cancels that 1/facing
      // projection exactly, so a shell already renders as a FLAT disc and the
      // volume fill is no longer paying for itself -- it is pure centre spike.
      // Its surface brightness at screen radius p is the integral of f(s)/s^2
      // from p out to the surface, and pow(rnd(), 0.52) gives f(s) ~ s^0.923,
      // leaving an s^-1.077 integrand that diverges toward the middle. Measured
      // centre:mid was 170:45 against a reference that is flat at ~70.
      //
      // So: a thick shell just inside the skin, ending BELOW the skin's start
      // (0.955 < 0.972) so the skin's pile-up reads as its own ring rather than
      // smearing into the shell's taper. Every sub-shell contributes its own
      // flat disc out to its own radius, they stack, and the taper over the
      // last stretch is where the skin's own limb pile-up takes over.
      //
      // The inner edge is the centre control. A sub-shell of radius s only
      // brightens screen radii below s, so pulling the inner edge down from 0.86
      // adds light to the middle of the disc and leaves the mid bins alone --
      // which is what bin 0 needed after the body trim left it at 48.4 against
      // the reference's 82.7. It stays a bounded shell rather than a volume
      // fill: the old pow(rnd(), 0.52) put an s^-1.077 integrand under the
      // centre and that is what spiked it to 170 in the first place.
      // Sits just inside the skin (0.938 start) so its silhouette reads as a
      // soft inner taper rather than a second ring. Kept bounded: the old volume
      // fill put an s^-1.077 integrand under the centre and spiked it to 170.
      shell = 0.70 + rnd() * 0.236;
    } else if (t < 0.893) {
      // Mid shell. The inner shell above starts at 0.70, which projects to
      // r=148 px, so every one of its sub-shells covers the whole inner disc
      // uniformly -- adding motes to it lifts r=30..140 and r=150..200 together,
      // and r=150..200 already matches (76.6 against the reference's 76.5 at
      // r=150). This population tops out at 0.64, i.e. r=137 px, so it lands
      // only where the capture was short: 60-66 across r=30..80 against 66-69.
      shell = 0.34 + rnd() * 0.30;
    } else if (t < 0.9045) {
      // Nucleus. The reference's centre bin reads 82.7 against 69/66/70 for the
      // three bins outside it, so the middle of the disc is not just the flat
      // sum of the shells above -- there is a compact bright core sitting on
      // top of it. Radius is what selects which bins it touches: a sub-shell of
      // radius s lights screen radii below s, so keeping this under ~0.35 puts
      // all of it in bins 0-1 and none of it in the mid bins that already match.
      // Small area means few motes are needed for a lot of surface brightness.
      //
      // Radius comes from the projection, not from taste. For small s the map is
      // near-linear: NDC ~ f*s/d = 0.684*s, so r_px = 300*0.684*s = 205*s. The
      // reference's spike is confined to r<20 px (101.2 inside 10, 79.6 by 20,
      // and back to the body's 70 by 30), which is world s < 0.10. Spanning
      // 0.08-0.48 spread the same motes out to r=98 px instead: it made a broad
      // pedestal that left the middle at 66.3 against 101.2 while pushing r=30-50
      // to 73-75 against the reference's 67-70. Same energy, wrong radius.
      //
      // The profile of a nested set of shells inverts directly. A shell of world
      // radius x lays down a flat disc of height proportional to n(x)/x^2 (the
      // 1/facing pile-up is already cancelled by the body's facing weight, and
      // the 1/x^2 is just its area), so the excess over the body floor at screen
      // radius r is E(r) = C * integral of n(x)/x^2 from x=r/205 out.
      //
      // The reference's excess is 34, 13, 4, 1 at r = 10, 20, 30, 40 px. Take
      // differences and divide by x^2 and n(x) comes out FLAT across 0.05-0.20
      // (2.28, 2.74, 1.76) -- so the population is uniform out to world 0.21, and
      // the falling profile is entirely the 1/x^2. An exponent here is wrong twice
      // over: at 2.4 it put everything inside world 0.05 and measured 125.7 at
      // r=10 against 101.2 while r=20 fell to 64.5 against 79.6, and the flat
      // 0.02-0.105 span before it had the same shape for the same reason -- it
      // simply ended before the radii that feed r=20.
      //
      // Uniform 0.02-0.21 predicts 34.0 / 11.8 / 4.5 / 0.8 against 34 / 13 / 4 / 1.
      shell = 0.02 + rnd() * 0.19;
    } else {
      // Loose dust just outside the limb. Kept sparse and close in -- a fat
      // outer population reads as a fuzzy halo, and the reference has only a
      // scatter of stray motes near where the bright arcs break the edge.
      //
      // This is what sets the ring's SHAPE, which is why it is now much thinner.
      // The reference peaks at band 0.85-0.95 (96.6) and falls to 52.2 just
      // outside it; every brightness term here is a monotonic function of facing
      // and so can only peak at the silhouette, meaning that outer band is dark
      // in the reference for the simple reason that there is nothing out there.
      // At 1.5% spread over 1.012-1.067 this population was holding that band up
      // at 70.4 and flattening the ring away entirely.
      //
      // This population is what positions the ring, by the argument above: it
      // reaches past the skin, so it pushes the measured 97%-energy R outward and
      // leaves the skin's pile-up sitting at 0.85-0.95 R rather than at 0.96. That
      // only works if it is DIM. At full per-mote brightness it held the outer band
      // at 97.8 against the skin's 98.5 -- a ratio of 0.99 where the reference is
      // 52.2/96.6 = 0.54 -- so the ring had no outside edge to be an edge against.
      // It is dimmed via a_rand.z below rather than by cutting its count, since the
      // reach is what does the work.
      // Loose dust outside the limb. This population does NOT set the ring's
      // brightness -- it sets where the ring lands in R units, and R is measured,
      // not chosen.
      //
      // The arithmetic that was missing: R came out 222px and world 1.0 projects
      // to 217px, so R was world 1.023 and the skin at 0.972-0.988 sat at
      // 0.950-0.966 R -- inside the OUTERMOST band. That is the whole defect. The
      // reference peaks at 0.85-0.95 R, which needs R near world 1.09, i.e. the
      // 97%-energy radius has to sit ~11% outside the skin rather than ~4%.
      //
      // So the earlier instinct (dim it, pull it in) was backwards: shrinking this
      // population pulls R in with it and the ring rides back out to 0.96 R every
      // time. It has to reach FURTHER. What must come down is per-mote brightness,
      // via haloDim in the shader, so the band reads 0.54 of the peak the way the
      // reference does rather than going dark -- the reference's outer band is 52.2,
      // which is dim, not empty.
      // Butts up against the skin (0.954) rather than starting at 1.00, which
      // would have left a visible dark gap now that the body has shrunk. The
      // reference's luma dies out by r=235 px, i.e. world ~1.04, so that is where
      // this ends -- it is the falloff outside the ring, not a second object.
      // Reach is set by inverting the projection against where the reference
      // actually dies, not by eye: r_px = 300 * f*s/sqrt(d^2-s^2), so world
      // 1.068 lands at 234 px and 1.15 lands at 256. The reference is 7.2 at
      // r=240 and 0.5 by 270, so 1.15 was drawing a tail 30 px past the end of
      // the object -- it measured 29.9 at r=240 and 21.6 at r=250 against 7.2
      // and 3.7. Only a shell whose own silhouette lies past a radius can put
      // light there, so the ceiling IS the tail length.
      //
      // The exponent is under 1 (outward bias) for the same reason. r=230 can
      // only be lit by shells above 1.047, which is the top sixth of this span,
      // so an inward bias starves exactly the annulus R is decided in: at 1.7
      // the tail past 240 came out right but r=230 read 10.5 against 29.2.
      // Span trimmed 0.114 -> 0.098 (ceiling 1.052, i.e. r=231 px) when the fringe
      // went from a 0/2 binary cut to a power-law arc distribution: concentrating
      // the same halo energy into fewer, brighter azimuths moves energy outward at
      // fixed reach, and R ran 223 -> 233. The distribution is what the reference
      // measures, so the reach gives way, not the arcs.
      shell = 0.954 + 0.098 * Math.pow(rnd(), 0.8);
    }

    base[i * 3 + 0] = r * Math.cos(phi) * shell;
    base[i * 3 + 1] = u * shell;
    base[i * 3 + 2] = r * Math.sin(phi) * shell;

    rand[i * 4 + 0] = rnd();
    // Tight size jitter. A wide spread makes the body look like gravel; the
    // reference dust is uniform enough that only the filaments stand out.
    rand[i * 4 + 1] = 0.8 + rnd() * 0.4;
    // A hair over 1% burn much brighter -- the sparkles along the ribbons. At
    // 3.5% they covered the whole face in white speckle.
    // The halo is scaled down hard here: it has to REACH past the skin to push
    // the measured R outward, but stay dim enough that the band outside the ring
    // falls to roughly half the ring's brightness the way the reference does.
    rand[i * 4 + 2] = rnd() < 0.012 ? 1.6 + rnd() * 1.4 : 0.55 + rnd() * 0.45;
    rand[i * 4 + 3] = rnd();
  }

  return { base, rand, count };
}

export const ORB1: OrbSpec = {
  id: "orb1",
  label: "Orb 1 — chromatic dust",
  note: "Charcoal dust body with curl-driven violet filaments and a blown-out limb.",
  vert: VERT,
  frag: FRAG,
  // High on purpose. The reference body is smooth enough to read as a surface
  // rather than as dots, and the only honest way there is more, smaller motes --
  // widening the filament sheet or brightening the body both wash it out.
  defaultCount: 900000,
  camDist: 2.95,
  fov: 0.92,
  build,
};
