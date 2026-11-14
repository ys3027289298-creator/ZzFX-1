# MIDI Export Verification Report

date: 2026-11-14T05:06:46Z

## 1. Automated checks (node output/verify_midi.mjs)

```
PASS  smf header: format 0, 1 track, division = PPQ
PASS  tempo meta event matches bpm  -- tempo=500000
PASS  end-of-track present
PASS  exactly one note
PASS  note number = 69 (A4 440Hz)  -- note=69
PASS  velocity = 127 at volume 1  -- vel=127
PASS  note duration matches envelope at bpm  -- 586 == 586
PASS  no diagnostics when everything maps
PASS  pitch offset +12 semitones -> note 81  -- note=81
PASS  duration rescales with bpm 240  -- 1171 == 1171
PASS  tempo meta matches bpm 240  -- tempo=250000
PASS  slide produces a pitch bend curve  -- 13 bends
PASS  bend curve rises for upward slide  -- final bend=16383
PASS  sustainVolume .5 -> CC11 expression  -- cc11=64
PASS  diagnostic mentions randomness
PASS  diagnostic mentions shape
PASS  diagnostic mentions shapeCurve
PASS  diagnostic mentions pitchJump
PASS  diagnostic mentions repeatTime
PASS  diagnostic mentions tremolo
PASS  diagnostic mentions noise
PASS  diagnostic mentions bitCrush
PASS  diagnostic mentions delay
PASS  diagnostic mentions modulation
PASS  diagnostic mentions filter
PASS  unmappable params do not change note count
PASS  frequency 0 diagnosed
PASS  zero-length envelope diagnosed
PASS  volume > 1 clamp diagnosed
PASS  audio source files untouched by this change  -- clean
PASS  buildSamples sample counts unchanged vs HEAD

wrote output/sample_tone.mid, output/sample_slide.mid, output/sample_kitchen_sink.mid

31/31 checks passed
```

## 2. Independent parse with mido (python MIDI library)

```
output/sample_tone.mid | fmt 0 | tpb 480 | 0.610s | notes [(69, 127)] | bends 0 | ccs [] | bpm 120
output/sample_slide.mid | fmt 0 | tpb 480 | 0.610s | notes [(69, 127)] | bends 13 | ccs [] | bpm 120
output/sample_kitchen_sink.mid | fmt 0 | tpb 480 | 0.610s | notes [(57, 127)] | bends 13 | ccs [(11, 89)] | bpm 90
output/demo_export.mid | fmt 0 | tpb 480 | 0.100s | notes [(45, 127)] | bends 0 | ccs [] | bpm 90
```

## 3. Audio zero regression

```
audio source files: no changes
```
