# Audio Reader

A local-first book reader for uploaded `.txt`, `.epub`, and `.pdf` files with browser text-to-speech, speed and voice controls, word highlighting, reading progress, bookmarks, and focus mode.

## Run

```sh
npm install
npm run dev
```

The current dev server is running at:

```txt
http://127.0.0.1:5174/
```

## TTS Recommendation

The first engine is the browser's built-in `SpeechSynthesis` API. It is the best default for a personal prototype because it is private, free, instant, and does not need API keys.

Good next upgrades:

- OpenAI TTS for natural cloud narration and app-controlled voices.
- ElevenLabs for highly expressive narration and voice design.
- Azure Speech, Google Cloud Text-to-Speech, or Amazon Polly for broad language support and production-grade cloud controls.

The app is structured so those can be added later behind the same voice, speed, pitch, and volume controls.
# BookReader
