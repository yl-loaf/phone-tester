# Phone Stress Tester

A lightweight static website for stressing common phone hardware from the browser. Designed for **GitHub Pages**.

## Features

| Feature | What it does |
|---------|----------------|
| **Torch** | Turns on the rear-camera flashlight at maximum brightness when supported |
| **Rear Camera** | Opens the environment-facing camera and shows a live preview |
| **Constant Vibration** | Loops `navigator.vibrate` for continuous haptic feedback |
| **Network Download Stress** | Repeatedly downloads large files (or generates local traffic) for a set duration or infinitely |
| **GPU Fractal Tester** | Renders an animated Julia-set fractal on canvas with a live FPS counter |
| **Estimated Power** | Rough cumulative watt estimate based on which features are active |
| **Tone Generator** | Plays a continuous sine tone with frequency (50–2000 Hz) and volume sliders |

## Deploy to GitHub Pages

1. Create a new repository on GitHub (public).
2. Upload the contents of this folder (`index.html`, `styles.css`, `app.js`, `README.md`) to the root of the repo, **or** put them in a `/docs` folder.
3. Go to **Settings → Pages**.
4. Under **Source**, choose:
   - Branch: `main` (or `master`)
   - Folder: `/ (root)` or `/docs`
5. Save. After a minute your site will be live at:

   `https://<your-username>.github.io/<repo-name>/`

## Usage notes

- Open the page **on your phone** in Chrome, Safari, or Firefox.
- Grant camera / microphone permissions when prompted (camera is used for torch + preview).
- Torch support varies: it works best on Android Chrome. iOS Safari has limited torch control.
- Vibration may be throttled or disabled by the OS after prolonged use.
- Network stress uses public speed-test endpoints; if CORS blocks them the page falls back to generating local memory traffic.
- Power figures are **estimates only**. Browsers cannot read real battery power draw.

## License

MIT — free to use and modify.
