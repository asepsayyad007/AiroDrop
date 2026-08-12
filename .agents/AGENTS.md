# AGENTS.md — Critical Project Rules & Immutable Behavior

## 🔒 IMMUTABLE MEDIA PREVIEW & NATIVE VIDEO PLAYER RULES (DO NOT TOUCH)

1. **MEDIA TYPE PREVIEWS ONLY**:
   - Preview is enabled **EXCLUSIVELY** for 3 media types:
     - **Images**: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.svg`, `.heic`, `.bmp`
     - **Videos**: `.mp4`, `.mov`, `.m4v`, `.webm`, `.ogv`, `.avi`, `.mkv`
     - **Music/Audio**: `.mp3`, `.wav`, `.m4a`, `.ogg`, `.flac`, `.aac`
   - For **ALL OTHER FILE TYPES** (PDF, ZIP, DOCX, TXT, EXE, ISO, etc.), DO NOT attempt iframe or canvas rendering. Show the **"Cannot preview this file type. Download instead"** card with the **Download Instead** button.

2. **NATIVE MOBILE VIDEO PLAYER LAUNCH & NON-DISMISSABLE PLAYBACK**:
   - Tapping a video file launches `#mobileVideoLightbox` in the foreground AND automatically triggers native mobile full-screen media player (`video.webkitEnterFullscreen()`).
   - Tapping on the video player element (`#mobileVideoEl`), video controls, or timeline scrubber MUST NEVER close the modal (`event.stopPropagation()`).
   - ONLY clicking the red/orange `✕` Close button (`#btnCloseMobileVideo`) or dark backdrop background closes the video player.

3. **ZERO BACKGROUND AUDIO / PLAYBACK**:
   - `files.html` iframe delegates preview events directly to `window.parent` and returns immediately.
   - Closing any preview modal MUST invoke `media.pause()`, `media.removeAttribute('src')`, and `media.load()` to halt all audio and video playback.
