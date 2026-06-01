# 📖 Audio Reader

**A powerful, local-first book reader featuring in-browser Text-to-Speech (TTS), intelligent PDF parsing, and a distraction-free reading environment.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://makeapullrequest.com)

**[🚀 Live Demo on Vercel](https://book-reader-bice.vercel.app/)**

## ✨ Features

- **Multi-Format Support**: Upload and read `.txt`, `.epub`, and `.pdf` files natively in your browser.
- **Smart PDF Rendering**: PDFs aren't just flattened into plain text! The app maintains original page structures (including images and equations) while the TTS seamlessly follows the underlying text layer.
- **Intelligent Narration**:
  - Math-like text regions are paused and highlighted instead of read aloud awkwardly.
  - Pages with embedded images trigger visual pauses before continuing narration.
- **Robust TTS Controls**: Adjust reading speed, change voices, and tweak pitch/volume directly in the UI.
- **Reading Enhancements**:
  - Word-by-word highlighting as it's spoken.
  - Reading progress tracking and bookmarking.
  - Focus Mode for a distraction-free reading experience.
- **Local-First & Private**: Everything happens locally in your browser. No files are uploaded to any server.

## 🛠️ Tech Stack

- **Framework**: React 19 + TypeScript + Vite
- **Styling**: Vanilla CSS with modern custom properties
- **PDF Parsing**: `pdfjs-dist`
- **Speech**: Native browser `SpeechSynthesis` API

## 🚀 Getting Started

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) installed on your machine.

### Installation

1. Clone the repository:
   ```sh
   git clone https://github.com/Killer-Mayor/BookReader.git
   cd BookReader
   ```
2. Install dependencies:
   ```sh
   npm install
   ```
3. Start the development server:
   ```sh
   npm run dev
   ```
4. Open your browser and navigate to `http://127.0.0.1:5174/` (or the port specified in your terminal).

## 🗣️ Text-To-Speech (TTS) Architecture

By default, this app uses the browser's built-in `SpeechSynthesis` API. It is the perfect starting point because it is 100% private, free, instant, and requires zero API keys.

**Potential Upgrades:**
The app's TTS module is architected flexibly, allowing you to plug in premium cloud providers behind the same UI controls (voice, speed, pitch, volume):
- **OpenAI TTS**: For incredibly natural cloud narration.
- **ElevenLabs**: For highly expressive voice design.
- **Cloud Providers**: Azure Speech, Google Cloud TTS, or Amazon Polly for broad multi-language support.

## 🤝 Contributing

Contributions, issues, and feature requests are highly welcome! I want to make this the best open-source web reader possible.

- **Found a bug or have a feature idea?** Please [open an issue](https://github.com/Killer-Mayor/BookReader/issues) and let's discuss it!
- **Want to write some code?** 
  1. Fork the project.
  2. Create your feature branch (`git checkout -b feature/AmazingFeature`).
  3. Commit your changes (`git commit -m 'Add some AmazingFeature'`).
  4. Push to the branch (`git push origin feature/AmazingFeature`).
  5. Open a Pull Request.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
