# Security

VibeTake runs on your machine. What leaves it, and what does not:

- **Leaves the machine:** the voice track of a recording, sent to the transcription provider you put
  a key for in `.env.local` (OpenAI or OpenRouter), by the local service, at Stop or when you run
  `vibetake transcribe`. Nothing else is sent anywhere.
- **Stays on the machine:** the screen video, the stills, the camera clip, the steps, the transcript
  once it is back, and your key. The key is read by the local service only and never enters the
  browser.
- **The local service** listens on `127.0.0.1` only and answers only requests carrying a pairing
  secret it minted into `config/pairing-secret` (mode 0600). The extension fetches that secret
  itself; a web page cannot obtain it or spend your key.

## Reporting a vulnerability

Please do not open a public issue. Email ghoshsanjoy@gmail.com with the details and, if you can, a
way to reproduce it. You will get a reply within a week.
