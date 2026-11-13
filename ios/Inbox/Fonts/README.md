These are copies of the window's fonts (`web/src/fonts/*.woff2`), re-wrapped as TrueType because iOS doesn't read woff2.
Regenerate them from there rather than editing them:

```bash
python3 -m venv V && V/bin/pip install fonttools brotli
V/bin/python -c "from fontTools.ttLib import TTFont; import sys; f = TTFont(sys.argv[1]); f.flavor = None; f.save(sys.argv[2])" in.woff2 out.ttf
```

Both are variable fonts under the SIL Open Font License 1.1: Instrument Sans (c) The Instrument Sans Project Authors,
JetBrains Mono (c) The JetBrains Mono Project Authors.
