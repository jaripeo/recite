'use strict';
console.log("TTS Reader: initializing.");

// ── PWA assets ────────────────────────────────────────────────────────────────
// Injects the app icon and Web App Manifest into <head> at startup.
// Runs before DOMContentLoaded so Safari picks up the manifest on "Add to
// Home Screen".
(function injectPwaAssets() {
    // App Icon: canvas → PNG data-URI → <link rel="apple-touch-icon">
    try {
        const SZ = 512;
        const c = document.createElement('canvas');
        c.width = c.height = SZ;
        const ctx = c.getContext('2d');

        // Rounded-rectangle background (iOS icon shape)
        const R = 110;
        ctx.beginPath();
        ctx.moveTo(R, 0);  ctx.lineTo(SZ - R, 0);
        ctx.arcTo(SZ, 0,   SZ,     R,   R);
        ctx.lineTo(SZ, SZ - R);
        ctx.arcTo(SZ, SZ,  SZ - R, SZ,  R);
        ctx.lineTo(R, SZ);
        ctx.arcTo(0,  SZ,  0,      SZ - R, R);
        ctx.lineTo(0, R);
        ctx.arcTo(0,  0,   R,      0,  R);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, 0, SZ, SZ);
        grad.addColorStop(0, '#1a8fff');
        grad.addColorStop(1, '#0044cc');
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.lineWidth   = 28;
        ctx.lineCap     = 'round';
        // Triangle play body
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath();
        ctx.moveTo(170, 160);
        ctx.lineTo(170, 352);
        ctx.lineTo(340, 256);
        ctx.closePath();
        ctx.fill();
        // Sound arcs
        ctx.beginPath(); ctx.arc(340, 256, 60,  -0.8, 0.8); ctx.stroke();
        ctx.beginPath(); ctx.arc(340, 256, 105, -1.0, 1.0); ctx.stroke();

        const iconLink = document.createElement('link');
        iconLink.rel   = 'apple-touch-icon';
        iconLink.sizes = '512x512';
        iconLink.href  = c.toDataURL('image/png');
        document.head.appendChild(iconLink);
    } catch (_) { /* canvas unavailable */ }

    // Web App Manifest via Blob URL
    try {
        const manifest = {
            name:             'TTS EPUB Reader',
            short_name:       'TTS Reader',
            description:      'Offline text-to-speech reader for EPUB and plain text',
            display:          'standalone',
            background_color: '#f2f2f7',
            theme_color:      '#007AFF',
            orientation:      'portrait-primary',
            start_url:        '.'
        };
        const blob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
        const mLink = document.createElement('link');
        mLink.rel  = 'manifest';
        mLink.href = URL.createObjectURL(blob);
        document.head.appendChild(mLink);
    } catch (_) { /* Blob URLs unavailable */ }
})();

// ── iOS detection ─────────────────────────────────────────────────────────────
// Used for the broken speechSynthesis.resume() workaround.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ── DOM References ────────────────────────────────────────────────────────────
const dom = {
    // Top bar
    menuBtn:            document.getElementById('menuBtn'),
    wakeLockBtn:        document.getElementById('wakeLockBtn'),
    statusMessage:      document.getElementById('statusMessage'),
    // Reader
    plainTextMode:      document.getElementById('plainTextMode'),
    renderedTextMode:   document.getElementById('renderedTextMode'),
    epubMode:           document.getElementById('epubMode'),
    // Bottom bar
    readingProgress:    document.getElementById('readingProgress'),
    progressPercentage: document.getElementById('progressPercentage'),
    prevBtn:            document.getElementById('prevBtn'),
    playToggleBtn:      document.getElementById('playToggleBtn'),
    nextBtn:            document.getElementById('nextBtn'),
    settingsToggleBtn:  document.getElementById('settingsToggleBtn'),
    // Settings sheet
    settingsSheet:      document.getElementById('settingsSheet'),
    settingsHandle:     document.getElementById('settingsHandle'),
    epubInput:          document.getElementById('epubInput'),
    charCount:          document.getElementById('charCountDisplay'),
    wordCount:          document.getElementById('wordCountDisplay'),
    estTime:            document.getElementById('estTimeDisplay'),
    voiceFilterLang:    document.getElementById('voiceFilterLang'),
    voiceFilterGender:  document.getElementById('voiceFilterGender'),
    voiceSelect:        document.getElementById('voiceSelect'),
    favoriteVoiceBtn:   document.getElementById('favoriteVoiceBtn'),
    hideVoiceBtn:       document.getElementById('hideVoiceBtn'),
    clearHiddenVoicesBtn: document.getElementById('clearHiddenVoicesBtn'),
    speedRange:         document.getElementById('speedRange'),
    speedValue:         document.getElementById('speedValue'),
    // TOC sheet
    tocSheet:           document.getElementById('tocSheet'),
    tocHandle:          document.getElementById('tocHandle'),
    tocContainer:       document.getElementById('tocContainer'),
    // Overlay
    sheetOverlay:       document.getElementById('sheetOverlay'),
    // Floating "Start from here" popover
    wordPopover:        document.getElementById('wordPopover'),
    // Transparent EPUB tap-capture overlay (parent-document, above iframe)
    epubTapOverlay:     document.getElementById('epubTapOverlay')
};

// ── Central State ─────────────────────────────────────────────────────────────
const appState = {
    fullText:          "",
    globalCharIndex:   0,
    playbackState:     "idle",   // idle | starting | speaking | paused
    isEpubActive:      false,
    epubBook:          null,
    epubRendition:     null,
    deadVoices:        [],
    favoriteVoices:    [],
    wordMap:           [],       // { span, start, end }[]
    sentenceMap:       [],
    activeUtterance:   null,
    activeRequestId:   0,
    playbackChunks:    [],       // { text, offsetInFull }[]
    currentChunkIndex: 0,
    voiceStartTimeout: null,     // stored in state so cancelCurrentSpeech can clear it
    pendingStartIndex: null      // char index the "Start from here" popover will play from
};

// ── Storage Helpers ───────────────────────────────────────────────────────────
const storageHelpers = {
    get(key, defaultValue) {
        try {
            const item = window.localStorage.getItem(key);
            return item ? JSON.parse(item) : defaultValue;
        } catch (e) {
            console.warn(`localStorage get [${key}]:`, e);
            return defaultValue;
        }
    },
    set(key, value) {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.warn(`localStorage set [${key}]:`, e);
        }
    }
};

// ── Persistence & Session ─────────────────────────────────────────────────────
function setStatus(message) {
    dom.statusMessage.textContent = message;
}

function loadVoiceLists() {
    appState.deadVoices     = storageHelpers.get('deadVoices', []);
    appState.favoriteVoices = storageHelpers.get('favoriteVoices', []);
}

function saveSession() {
    storageHelpers.set('readerSession', {
        text:      dom.plainTextMode.value,
        voiceName: dom.voiceSelect.value,
        speed:     parseFloat(dom.speedRange.value),
        charIndex: appState.globalCharIndex
    });
}

function restoreSession() {
    loadVoiceLists();
    const session = storageHelpers.get('readerSession', null);
    if (session) {
        if (session.text)  { dom.plainTextMode.value = session.text;  appState.fullText = session.text; }
        if (session.speed) { dom.speedRange.value = session.speed;    dom.speedValue.textContent = session.speed + 'x'; }
        if (session.charIndex !== undefined) appState.globalCharIndex = session.charIndex;
        setStatus("Session restored");
    } else {
        setStatus("Ready");
    }
}

restoreSession();

// ── Voice Management ──────────────────────────────────────────────────────────
const genderHeuristics = {
    female: ['zira','susan','hazel','heera','haruka','huihui','elsa','anna','samantha','karen','moira','tessa','veena','victoria','siri','female'],
    male:   ['david','george','ravi','mark','ichiro','kangkang','pavel','stefan','daniel','oliver','male']
};

function guessGender(voiceName) {
    const n = voiceName.toLowerCase();
    for (const k of genderHeuristics.female) if (n.includes(k)) return 'female';
    for (const k of genderHeuristics.male)   if (n.includes(k)) return 'male';
    return 'unknown';
}

function getDisplayLanguage(langCode) {
    if (!langCode) return 'Unknown';
    try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(langCode.split('-')[0]) || langCode;
    } catch (_) {
        return langCode;
    }
}

let allVoices = [];

function loadVoices() {
    allVoices = window.speechSynthesis.getVoices();
    if (allVoices.length === 0) return;
    renderVoiceUI();
}

function renderVoiceUI() {
    const langFilter   = dom.voiceFilterLang.value;
    const genderFilter = dom.voiceFilterGender.value;

    const languages = new Set();
    allVoices.forEach(v => { if (v.lang) languages.add(v.lang.split('-')[0]); });

    if (dom.voiceFilterLang.options.length === 1) {
        Array.from(languages).sort().forEach(lang => {
            const opt = document.createElement('option');
            opt.value = lang;
            opt.textContent = getDisplayLanguage(lang);
            dom.voiceFilterLang.appendChild(opt);
        });
    }

    dom.voiceSelect.innerHTML = '';

    let filtered = allVoices.filter(voice => {
        if (appState.deadVoices.includes(voice.name)) return false;
        const vl = voice.lang ? voice.lang.split('-')[0] : '';
        if (langFilter !== 'all' && vl !== langFilter) return false;
        if (genderFilter !== 'all' && guessGender(voice.name) !== genderFilter) return false;
        return true;
    });

    filtered.sort((a, b) => {
        const af = appState.favoriteVoices.includes(a.name);
        const bf = appState.favoriteVoices.includes(b.name);
        if (af && !bf) return -1;
        if (!af && bf) return  1;
        return a.name.localeCompare(b.name);
    });

    if (filtered.length === 0) {
        dom.voiceSelect.innerHTML = '<option value="">No voices match filters</option>';
        return;
    }

    filtered.forEach(voice => {
        const opt = document.createElement('option');
        opt.value = voice.name;
        const star = appState.favoriteVoices.includes(voice.name) ? '★ ' : '';
        opt.textContent = `${star}${voice.name} (${getDisplayLanguage(voice.lang)})`;
        dom.voiceSelect.appendChild(opt);
    });

    const session = storageHelpers.get('readerSession', null);
    if (session && session.voiceName &&
        Array.from(dom.voiceSelect.options).some(o => o.value === session.voiceName)) {
        dom.voiceSelect.value = session.voiceName;
    }
}

window.speechSynthesis.onvoiceschanged = loadVoices;
loadVoices();
const voiceRetry = setInterval(() => {
    if (allVoices.length > 0) { clearInterval(voiceRetry); } else { loadVoices(); }
}, 1000);

dom.voiceFilterLang.addEventListener('change', renderVoiceUI);
dom.voiceFilterGender.addEventListener('change', renderVoiceUI);
dom.voiceSelect.addEventListener('change', saveSession);

dom.favoriteVoiceBtn.addEventListener('click', () => {
    const v = dom.voiceSelect.value;
    if (!v) return;
    if (appState.favoriteVoices.includes(v)) {
        appState.favoriteVoices = appState.favoriteVoices.filter(x => x !== v);
    } else {
        appState.favoriteVoices.push(v);
    }
    storageHelpers.set('favoriteVoices', appState.favoriteVoices);
    renderVoiceUI();
});

dom.hideVoiceBtn.addEventListener('click', () => {
    const v = dom.voiceSelect.value;
    if (!v || appState.deadVoices.includes(v)) return;
    appState.deadVoices.push(v);
    storageHelpers.set('deadVoices', appState.deadVoices);
    renderVoiceUI();
    setStatus("Voice hidden. Tap Restore in settings.");
});

dom.clearHiddenVoicesBtn.addEventListener('click', () => {
    appState.deadVoices = [];
    storageHelpers.set('deadVoices', appState.deadVoices);
    renderVoiceUI();
    setStatus("Hidden voices restored");
});

// ── Wake Lock ─────────────────────────────────────────────────────────────────
//
// The Screen Wake Lock API (iOS 16.4+) prevents the screen from sleeping
// while TTS is active. Without it, iOS pauses the Web Speech API when the
// display turns off.
//
let wakeLock       = null;
let wakeLockWanted = false; // user's desired state (survives re-acquisition)

async function acquireWakeLock() {
    if (!wakeLockWanted)          return;
    if (!('wakeLock' in navigator)) return;
    if (wakeLock)                 return; // already held
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
            // The OS released the lock (e.g. tab hidden); clear our ref
            wakeLock = null;
            updateWakeLockUI();
        });
        updateWakeLockUI();
    } catch (err) {
        console.warn('Wake lock request failed:', err.name, err.message);
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release(); // triggers the 'release' event above
    }
}

function updateWakeLockUI() {
    if (wakeLock) {
        dom.wakeLockBtn.classList.add('wake-active');
        dom.wakeLockBtn.setAttribute('aria-label', 'Wake Lock: on (tap to turn off)');
        dom.wakeLockBtn.title = 'Screen awake while reading (tap to disable)';
    } else {
        dom.wakeLockBtn.classList.remove('wake-active');
        dom.wakeLockBtn.setAttribute('aria-label', 'Wake Lock: off (tap to turn on)');
        dom.wakeLockBtn.title = 'Tap to keep screen awake while reading';
    }
}

// Re-acquire when the user returns to the tab (iOS releases the lock on tab switch)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' &&
        appState.playbackState === 'speaking') {
        acquireWakeLock();
    }
});

dom.wakeLockBtn.addEventListener('click', async () => {
    if (wakeLock) {
        // User is toggling OFF
        wakeLockWanted = false;
        releaseWakeLock();
    } else {
        // User is toggling ON
        wakeLockWanted = true;
        await acquireWakeLock();
        if (!wakeLock) {
            // API unavailable on this device/OS version
            setStatus("Wake Lock not available on this device");
        }
    }
    updateWakeLockUI();
});

// ── Playback Engine ───────────────────────────────────────────────────────────

const MAX_CHUNK_CHARS = 900;

/**
 * Split text into chunks from startIndex onward.
 * Uses exec() (not match()) to get match.index — the exact absolute offset
 * of each sentence inside fullText — so every chunk carries its own
 * offsetInFull. This eliminates cumulative-drift when mapping onboundary
 * charIndex back to the word map.
 *
 * Returns Array<{ text: string, offsetInFull: number }>
 */
function createPlaybackChunks(text, startIndex = 0) {
    const textToChunk = text.substring(startIndex);
    if (!textToChunk.trim()) return [];

    const chunks = [];
    // Trailing \s* consumed so the next match.index has no gap
    const sentenceRx = /[^.!?]*[.!?]+\s*|[^.!?]+$/g;
    let match;

    while ((match = sentenceRx.exec(textToChunk)) !== null) {
        const sentence      = match[0];
        const sentenceStart = startIndex + match.index;

        if (sentence.length <= MAX_CHUNK_CHARS) {
            chunks.push({ text: sentence, offsetInFull: sentenceStart });
        } else {
            // Sentence too long — slice at word boundaries, tracking exact positions
            let charPos = 0;
            while (charPos < sentence.length) {
                let end = Math.min(charPos + MAX_CHUNK_CHARS, sentence.length);
                if (end < sentence.length) {
                    const lastSpace = sentence.lastIndexOf(' ', end);
                    if (lastSpace > charPos) end = lastSpace + 1;
                }
                if (end <= charPos) end = charPos + MAX_CHUNK_CHARS; // safety
                chunks.push({
                    text:         sentence.substring(charPos, end),
                    offsetInFull: sentenceStart + charPos
                });
                charPos = end;
            }
        }
    }

    return chunks;
}

function updatePlaybackUI() {
    const s   = appState.playbackState;
    const btn = dom.playToggleBtn;
    const icon  = btn.querySelector('.btn-icon');
    const label = btn.querySelector('.btn-label');

    btn.classList.remove('is-speaking', 'is-paused');

    if (s === 'speaking') {
        icon.textContent  = '⏸';
        label.textContent = 'Pause';
        btn.classList.add('is-speaking');
        btn.disabled = false;
    } else if (s === 'paused') {
        icon.textContent  = '▶';
        label.textContent = 'Resume';
        btn.classList.add('is-paused');
        btn.disabled = false;
    } else if (s === 'starting') {
        icon.textContent  = '▶';
        label.textContent = 'Play';
        btn.disabled = true;
    } else {
        icon.textContent  = '▶';
        label.textContent = 'Play';
        btn.disabled = false;
    }

    // Nav buttons enabled only when an EPUB rendition is active
    const navEnabled = appState.isEpubActive && !!appState.epubRendition;
    dom.prevBtn.disabled = !navEnabled;
    dom.nextBtn.disabled = !navEnabled;

    // Status chip colour via data-state attribute
    const labels = { idle: 'Ready', starting: 'Loading…', speaking: 'Speaking', paused: 'Paused' };
    dom.statusMessage.textContent   = labels[s] || s;
    dom.statusMessage.dataset.state = s;
}

/**
 * cancelCurrentSpeech — cancels all in-flight speech, clears the broken-voice
 * timeout, releases the wake lock, and resets chunk state WITHOUT touching
 * globalCharIndex. This is the safe internal cancel used by click-to-word
 * and is called by stopSpeech().
 */
function cancelCurrentSpeech() {
    clearTimeout(appState.voiceStartTimeout);
    appState.voiceStartTimeout = null;

    window.speechSynthesis.cancel();

    // Release the screen wake lock — the screen may sleep again
    releaseWakeLock();

    // Bump request ID so stale onstart/onboundary/onend are silently discarded
    appState.activeRequestId++;
    appState.playbackState     = 'idle';
    appState.activeUtterance   = null;
    appState.playbackChunks    = [];
    appState.currentChunkIndex = 0;

    clearHighlights();
    updatePlaybackUI();
}

function resetPlaybackState() {
    cancelCurrentSpeech();
    updateProgress();
}

/** Full stop — cancel speech AND reset reading position to the beginning. */
function stopSpeech() {
    cancelCurrentSpeech();
    appState.globalCharIndex = 0;
    updateProgress();
    saveSession();
    setStatus("Stopped");
}

function pauseSpeech() {
    if (appState.playbackState !== 'speaking') return;
    window.speechSynthesis.pause();
    appState.playbackState = 'paused';
    releaseWakeLock(); // Screen may sleep while paused
    updatePlaybackUI();
    saveSession();
}

/**
 * resumeSpeech — iOS Safari's speechSynthesis.resume() is unreliable (it
 * silently fails in many WebKit builds). On iOS we cancel and restart from
 * globalCharIndex, which was updated on the last onboundary event.
 */
function resumeSpeech() {
    if (appState.playbackState !== 'paused') return;

    if (isIOS) {
        // iOS broken-resume workaround: rebuild chunks from current word position
        window.speechSynthesis.cancel();
        appState.activeRequestId++;
        appState.playbackChunks    = [];
        appState.currentChunkIndex = 0;
        appState.playbackState     = 'idle';
        clearHighlights();
        updatePlaybackUI();
        // wake lock will be re-acquired inside speakChunk → utterance.onstart
        //
        // iOS cancel()→speak() race: speaking synchronously right after the
        // cancel() above drops the utterance. Defer one macrotask so WebKit
        // flushes the cancel first. Speech is already unlocked (we were paused),
        // so the deferred speak() is still permitted.
        clearTimeout(appState.voiceStartTimeout);
        appState.voiceStartTimeout = setTimeout(() => {
            appState.voiceStartTimeout = null;
            startSpeech();
        }, 260);
    } else {
        window.speechSynthesis.resume();
        appState.playbackState = 'speaking';
        acquireWakeLock();
        updatePlaybackUI();
    }
}

/**
 * speakChunk — speaks one chunk. Each chunk carries its own offsetInFull so
 * onboundary can compute an exact absolute position with no cumulative drift.
 * voiceStartTimeout lives in appState so cancelCurrentSpeech() can always clear it.
 */
function speakChunk() {
    if (appState.currentChunkIndex >= appState.playbackChunks.length) {
        stopSpeech();
        setStatus("Finished reading");
        return;
    }

    const chunk       = appState.playbackChunks[appState.currentChunkIndex];
    const textToSpeak = chunk.text;
    const chunkOffset = chunk.offsetInFull; // absolute start in fullText

    const utterance = new SpeechSynthesisUtterance(textToSpeak);

    const selectedVoiceName = dom.voiceSelect.value;
    const voice = allVoices.find(v => v.name === selectedVoiceName);
    if (voice) utterance.voice = voice;
    utterance.rate = parseFloat(dom.speedRange.value);

    appState.activeUtterance = utterance;
    const currentReqId = ++appState.activeRequestId;

    utterance.onstart = () => {
        if (currentReqId !== appState.activeRequestId) return;
        clearTimeout(appState.voiceStartTimeout);
        appState.voiceStartTimeout = null;
        appState.playbackState = 'speaking';
        acquireWakeLock(); // Keep the screen on while speaking
        updatePlaybackUI();
    };

    utterance.onboundary = (event) => {
        if (currentReqId !== appState.activeRequestId) return;
        if (event.name !== 'word') return;
        // Exact absolute position: chunk's own offset + word's offset within chunk
        appState.globalCharIndex = chunkOffset + event.charIndex;
        updateProgress();
        syncHighlights();
        saveSession();
    };

    utterance.onend = () => {
        if (currentReqId !== appState.activeRequestId) return;
        appState.currentChunkIndex++;
        speakChunk();
    };

    utterance.onerror = (event) => {
        if (currentReqId !== appState.activeRequestId) return;
        clearTimeout(appState.voiceStartTimeout);
        appState.voiceStartTimeout = null;
        // 'canceled' / 'interrupted' fire when the user taps stop — not an error
        if (event.error !== 'canceled' && event.error !== 'interrupted') {
            console.error("Speech error:", event);
            resetPlaybackState();
            setStatus("Speech error — try another voice");
        }
    };

    // Enter 'starting' state before speak() so the timeout can detect a stalled voice
    appState.playbackState = 'starting';
    updatePlaybackUI();

    clearTimeout(appState.voiceStartTimeout);
    appState.voiceStartTimeout = setTimeout(() => {
        if (appState.playbackState !== 'starting') return;
        console.warn(`Voice [${selectedVoiceName}] timed out — marking as broken.`);
        window.speechSynthesis.cancel();
        if (selectedVoiceName && !appState.deadVoices.includes(selectedVoiceName)) {
            appState.deadVoices.push(selectedVoiceName);
            storageHelpers.set('deadVoices', appState.deadVoices);
            renderVoiceUI();
        }
        appState.voiceStartTimeout = null;
        resetPlaybackState();
        setStatus("Voice failed. Tap ⚙ to choose another.");
    }, 2000);

    window.speechSynthesis.speak(utterance);
}

/**
 * startSpeech — builds chunk array from globalCharIndex and begins speaking.
 * Callers MUST call cancelCurrentSpeech() first and set globalCharIndex
 * to the desired start position before calling this.
 */
function startSpeech() {
    if (!appState.fullText) return;
    appState.playbackChunks    = createPlaybackChunks(appState.fullText, appState.globalCharIndex);
    appState.currentChunkIndex = 0;
    speakChunk();
}

// ── EPUB Loading & Parsing ────────────────────────────────────────────────────

dom.epubInput.addEventListener('change', (e) => {
    // Close settings sheet so the loading status is visible
    closeSheet();
    const file = e.target.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.epub')) {
        setStatus("Please select a .epub file.");
        return;
    }
    stopSpeech();
    setStatus("Loading EPUB…");
    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            await loadEpubWithEpubJs(event.target.result);
        } catch (err) {
            console.warn("epub.js failed. Falling back to JSZip.", err);
            setStatus("Trying compatibility mode…");
            await loadEpubWithJSZipFallback(event.target.result);
        }
    };
    reader.readAsArrayBuffer(file);
});

async function loadEpubWithEpubJs(arrayBuffer) {
    return new Promise((resolve, reject) => {
        const renderTimeout = setTimeout(() => reject(new Error("epub.js render timeout")), 15000);
        try {
            dom.plainTextMode.style.display    = 'none';
            dom.renderedTextMode.style.display = 'none';
            dom.epubMode.style.display         = 'block';
            dom.epubTapOverlay.style.display   = 'none'; // hide during load; shown on display()
            appState.isEpubActive = true;

            if (appState.epubBook) appState.epubBook.destroy();

            appState.epubBook = ePub(undefined, { replacements: 'none' });
            appState.epubBook.open(arrayBuffer, 'binary');

            appState.epubRendition = appState.epubBook.renderTo(dom.epubMode, {
                width:  '100%',
                height: '100%',
                flow:   'paginated',
                spread: 'auto',
                allowScriptedContent: false
            });

            // Security: strip hostile elements before any content is shown
            appState.epubRendition.hooks.content.register((contents) => {
                ['script','iframe','object','embed'].forEach(tag => {
                    contents.document.querySelectorAll(tag).forEach(el => el.remove());
                });
            });

            appState.epubBook.loaded.navigation.then(nav => buildToc(nav.toc));

            // Re-build word map and touch handlers on every page turn
            appState.epubRendition.on('relocated', () => syncVisibleEpubText());

            appState.epubRendition.display().then(() => {
                clearTimeout(renderTimeout);
                // Show the parent-document overlay that captures EPUB taps on iOS
                dom.epubTapOverlay.style.display = 'block';
                // Nav buttons are enabled via updatePlaybackUI() inside syncVisibleEpubText(),
                // which fires from the 'relocated' event triggered by display() above.
                setStatus("EPUB loaded — tap a word or press Play");
                resolve();
            }).catch(reject);

        } catch (err) {
            clearTimeout(renderTimeout);
            reject(err);
        }
    });
}

async function loadEpubWithJSZipFallback(arrayBuffer) {
    try {
        appState.isEpubActive = false;
        dom.epubMode.style.display         = 'none';
        dom.epubTapOverlay.style.display   = 'none'; // no iframe in fallback mode
        updatePlaybackUI(); // disables nav buttons since isEpubActive is false

        const zip     = new JSZip();
        const archive = await zip.loadAsync(arrayBuffer);

        const containerFile = archive.file("META-INF/container.xml");
        if (!containerFile) throw new Error("container.xml missing.");
        const containerXml  = await containerFile.async("string");

        const parser       = new DOMParser();
        const containerDoc = parser.parseFromString(containerXml, "text/xml");
        const opfPath      = containerDoc.querySelector("rootfile").getAttribute("full-path");
        const opfXml       = await archive.file(opfPath).async("string");
        const opfDoc       = parser.parseFromString(opfXml, "text/xml");
        const basePath     = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

        const manifest = {};
        Array.from(opfDoc.querySelectorAll("manifest > item")).forEach(item => {
            manifest[item.getAttribute("id")] = item.getAttribute("href");
        });

        const spineIds = Array.from(opfDoc.querySelectorAll("spine > itemref")).map(i => i.getAttribute("idref"));
        let extractedText = "";
        let skips = 0;

        setStatus("Extracting text…");

        for (const id of spineIds) {
            const href = manifest[id];
            if (!href) continue;
            const filePath    = basePath + href;
            const chapterFile = archive.file(filePath) || archive.file(decodeURIComponent(filePath));
            if (!chapterFile) { skips++; continue; }

            const html     = await chapterFile.async("string");
            const chapDoc  = parser.parseFromString(html, "text/html");
            ['script','iframe','object','embed'].forEach(tag => {
                chapDoc.querySelectorAll(tag).forEach(el => el.remove());
            });
            const text = chapDoc.body ? chapDoc.body.textContent : chapDoc.documentElement.textContent;
            extractedText += text.replace(/\s+/g, ' ') + "\n\n";
        }

        if (!extractedText.trim()) throw new Error("No readable text found in spine.");

        dom.plainTextMode.value        = extractedText;
        dom.plainTextMode.style.display = 'block';
        appState.fullText              = extractedText;
        appState.globalCharIndex       = 0;
        dom.tocContainer.innerHTML     = '<i>TOC unavailable in fallback mode</i>';
        updateStats();
        setStatus(`Loaded via fallback.${skips ? ` (${skips} skipped)` : ''}`);

    } catch (err) {
        console.error("JSZip fallback failed:", err);
        setStatus("Error: could not parse EPUB.");
    }
}

// ── TOC & Navigation ──────────────────────────────────────────────────────────

function buildToc(tocArray) {
    dom.tocContainer.innerHTML = '';

    const flatten = (items, level = 0) => {
        items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'toc-item';
            div.style.paddingLeft = `${level * 16}px`;
            div.textContent = item.label;

            // Close the TOC sheet and navigate on tap
            div.addEventListener('click', () => {
                if (appState.epubRendition) appState.epubRendition.display(item.href);
                closeSheet();
            });

            dom.tocContainer.appendChild(div);
            if (item.subitems && item.subitems.length) flatten(item.subitems, level + 1);
        });
    };

    if (tocArray && tocArray.length) {
        flatten(tocArray);
    } else {
        dom.tocContainer.innerHTML = '<i>No table of contents available</i>';
    }
}

dom.prevBtn.addEventListener('click', () => { if (appState.epubRendition) appState.epubRendition.prev(); });
dom.nextBtn.addEventListener('click', () => { if (appState.epubRendition) appState.epubRendition.next(); });

// ── Text Stats & Progress ─────────────────────────────────────────────────────

function updateStats() {
    const text      = appState.fullText || dom.plainTextMode.value;
    const charCount = text.length;
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    dom.charCount.textContent = `Chars: ${charCount.toLocaleString()}`;
    dom.wordCount.textContent = `Words: ${wordCount.toLocaleString()}`;

    const speedMult    = parseFloat(dom.speedRange.value);
    const totalMinutes = (wordCount / 150) / speedMult;
    if (totalMinutes < 1) {
        dom.estTime.textContent = `Est: ${Math.round(totalMinutes * 60)}s`;
    } else if (totalMinutes < 60) {
        dom.estTime.textContent = `Est: ${Math.round(totalMinutes)} min`;
    } else {
        dom.estTime.textContent = `Est: ${Math.floor(totalMinutes / 60)}h ${Math.round(totalMinutes % 60)}m`;
    }
}

function updateProgress() {
    requestAnimationFrame(() => {
        if (!appState.fullText) return;
        const pct = Math.min(100, (appState.globalCharIndex / appState.fullText.length) * 100);
        dom.readingProgress.value          = pct;
        dom.progressPercentage.textContent = `${Math.floor(pct)}%`;
    });
}

// ── Touch Word-Tap Delegation ─────────────────────────────────────────────────
//
// Instead of attaching onclick to every span (expensive at scale and
// unreliable on iOS), we attach ONE delegated handler per container.
//
// Pattern:
//   touchstart — record start coords, reset moved flag
//   touchmove  — set moved flag (this was a scroll, not a tap)
//   touchend   — if not moved and target is a word span, act and
//                call preventDefault() to suppress the 300ms synthetic click
//   click      — fallback for desktop / pointer devices; suppressed on
//                touch devices by the touchend preventDefault above
//
function attachWordTapHandler(container) {
    // Guard against re-attaching on the same DOM element (e.g. EPUB body
    // persisting across page turns in the same iframe).
    if (container._wfTapAttached) return;
    container._wfTapAttached = true;

    // For EPUB spans, ownerDocument is the iframe's document — required for
    // elementFromPoint and caretRangeFromPoint to use the correct coordinate space.
    const ownerDoc = container.ownerDocument || document;

    let touchMoved  = false;
    let touchStartX = 0;
    let touchStartY = 0;

    container.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchMoved  = false;
    }, { passive: true });

    // Any movement beyond a few pixels → it's a scroll, not a tap
    container.addEventListener('touchmove', (e) => {
        if (Math.abs(e.touches[0].clientX - touchStartX) > 6 ||
            Math.abs(e.touches[0].clientY - touchStartY) > 6) {
            touchMoved = true;
        }
    }, { passive: true });

    container.addEventListener('touchend', (e) => {
        if (touchMoved) return;

        // ── iOS Safari critical fix ───────────────────────────────────────
        // e.target in touchend is the element at the TOUCH-START point, and
        // on iOS it is frequently a raw Text node (no .closest() method).
        // We resolve the word span via three fallbacks in order:
        //
        //   1. elementFromPoint(changedTouches[0]) — uses the LIFT coordinates;
        //      always returns an Element, never a Text node.
        //   2. e.target element walk — for desktop-style pointer events where
        //      changedTouches is absent or quantised differently.
        //   3. caretRangeFromPoint — WebKit caret-position API, navigates from
        //      text node to its parent element; catches sub-pixel gaps between
        //      glyph bounding boxes where elementFromPoint returns the body.
        // ─────────────────────────────────────────────────────────────────
        const touch = e.changedTouches[0];
        let target  = null;

        // Path 1: hit-test the exact lift point
        if (touch) {
            const el = ownerDoc.elementFromPoint(touch.clientX, touch.clientY);
            target = el ? el.closest('.wf-speech-word') : null;
        }

        // Path 2: walk up from e.target (guards against text-node references)
        if (!target) {
            const t = e.target;
            if (t && t.nodeType === Node.ELEMENT_NODE) {
                target = t.closest('.wf-speech-word');
            } else if (t && t.nodeType === Node.TEXT_NODE && t.parentElement) {
                target = t.parentElement.closest('.wf-speech-word');
            }
        }

        // Path 3: caret-range API (WebKit / Blink)
        if (!target && touch && ownerDoc.caretRangeFromPoint) {
            const range = ownerDoc.caretRangeFromPoint(touch.clientX, touch.clientY);
            if (range) {
                const node = range.startContainer;
                const el   = (node.nodeType === Node.TEXT_NODE) ? node.parentElement : node;
                target = el ? el.closest('.wf-speech-word') : null;
            }
        }

        // A tap on empty space (no word) dismisses any open popover.
        if (!target) { hideWordPopover(); return; }

        // Suppress the 300 ms synthetic click that iOS would fire next,
        // and stop propagation so the document-level epub handler doesn't
        // double-fire for the same tap.
        e.preventDefault();
        e.stopPropagation();

        // New UX: do NOT start speech here. Anchor the "Start from here"
        // popover to the word; speech begins from the popover's own tap.
        showPopoverForSpan(target, ownerDoc);
    }, { passive: false }); // passive: false is required to call preventDefault

    // Desktop / mouse / stylus fallback.
    // On real touch, the touchend's e.preventDefault() suppresses this synthetic click.
    container.addEventListener('click', (e) => {
        // Guard: e.target may be a text node on some desktop browsers too
        const el = e.target;
        const target = (el && el.closest) ? el.closest('.wf-speech-word') : null;
        if (!target) { hideWordPopover(); return; }
        showPopoverForSpan(target, ownerDoc);
    });
}

// ── Floating "Start from here" Popover ───────────────────────────────────────
//
// New UX (ElevenLabs-style): tapping a word no longer starts playback
// immediately. Instead we surface a small floating button anchored to the
// tapped word. Pressing it starts TTS from that word; tapping anywhere else
// dismisses it. Identical behaviour for the rendered plain-text view and
// the cross-document EPUB iframe view.
//
// Starting speech from the popover BUTTON's own tap (rather than from the
// word tap) gives us a clean, dedicated user gesture — which is what iOS
// Safari requires to unlock speechSynthesis — and lets us route through
// beginPlaybackFromIndex(), which side-steps the iOS cancel()→speak() race.

/**
 * getSpanRectInMainViewport — returns the tapped word's bounding rect in
 * MAIN-document viewport coordinates. EPUB word spans live inside an iframe,
 * so their getBoundingClientRect() is relative to the iframe's own viewport;
 * we translate that by adding the <iframe> element's offset in the main doc.
 */
function getSpanRectInMainViewport(span, ownerDoc) {
    const r = span.getBoundingClientRect();
    if (ownerDoc && ownerDoc !== document) {
        // Attempt 1: frameElement on the iframe's own window (works for
        // same-origin iframes that are NOT sandboxed).
        let frameEl = null;
        try {
            if (ownerDoc.defaultView) frameEl = ownerDoc.defaultView.frameElement;
        } catch (_) {}

        // Attempt 2: epub.js sandboxes its iframe, making frameElement null
        // from inside the iframe's context. Query the parent DOM directly.
        if (!frameEl && appState.isEpubActive) {
            frameEl = dom.epubMode.querySelector('iframe');
        }

        if (frameEl) {
            const fr = frameEl.getBoundingClientRect();
            return {
                left:   fr.left + r.left,  top:    fr.top + r.top,
                right:  fr.left + r.right, bottom: fr.top + r.bottom,
                width:  r.width,           height: r.height
            };
        }
    }
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
             width: r.width, height: r.height };
}

/** showPopoverForSpan — anchor the popover above (or below) a tapped word. */
function showPopoverForSpan(span, ownerDoc) {
    const start = parseInt(span.dataset.start, 10);
    if (isNaN(start)) return;
    appState.pendingStartIndex = start;

    const rect = getSpanRectInMainViewport(span, ownerDoc);
    const pop  = dom.wordPopover;

    pop.classList.remove('hidden'); // make it measurable (first show only)

    const pw = pop.offsetWidth  || 150;
    const ph = pop.offsetHeight || 40;

    let left = rect.left + rect.width / 2 - pw / 2;
    let top  = rect.top - ph - 10;           // prefer floating above the word
    if (top < 8) top = rect.bottom + 10;     // no room above → place below

    const margin = 8;
    left = Math.max(margin, Math.min(left, window.innerWidth  - pw - margin));
    top  = Math.max(margin, Math.min(top,  window.innerHeight - ph - margin));

    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';
    // rAF so the scale/opacity transition plays even on the first show
    requestAnimationFrame(() => pop.classList.add('visible'));
}

/** hideWordPopover — dismiss the popover and forget the pending position. */
function hideWordPopover() {
    appState.pendingStartIndex = null;
    dom.wordPopover.classList.remove('visible');
}

/**
 * beginPlaybackFromIndex — cancel any current speech and (re)start from an
 * absolute character index.
 *
 * iOS WebKit bug worked around here: speechSynthesis.cancel() followed by
 * speechSynthesis.speak() in the SAME synchronous turn causes WebKit to
 * discard the freshly-queued utterance — playback stops and never restarts.
 * (This was the original reason tapping a word "did nothing" on iOS: the tap
 * cancelled the live utterance and the immediate restart was dropped.)
 *
 * Fix: when we are interrupting speech that is already active/paused we defer
 * the restart to a later macrotask so the cancel can flush. Speech is already
 * unlocked in that case, so the deferred speak() is still permitted. Starting
 * from idle happens synchronously inside the caller's gesture — no cancel to
 * race against, and the gesture unlocks iOS speech the first time.
 */
function beginPlaybackFromIndex(index) {
    const wasActive = (appState.playbackState === 'speaking' ||
                       appState.playbackState === 'paused'   ||
                       appState.playbackState === 'starting');

    cancelCurrentSpeech();
    appState.globalCharIndex = index;

    if (wasActive && isIOS) {
        setStatus('Starting…');
        clearTimeout(appState.voiceStartTimeout);
        appState.voiceStartTimeout = setTimeout(() => {
            appState.voiceStartTimeout = null;
            startSpeech();
        }, 260);
    } else {
        startSpeech();
    }
}

/**
 * activateWordPopover — the dedicated user gesture that actually starts
 * speech. Handles both touchend (iOS) and click (desktop); a guard would be
 * redundant because preventDefault() on touchend suppresses the synthetic
 * click, but we null the pending index on hide so a stray second call no-ops.
 */
function activateWordPopover(e) {
    e.preventDefault();
    e.stopPropagation();
    const idx = appState.pendingStartIndex;
    hideWordPopover();
    if (idx !== null && idx !== undefined && !isNaN(idx)) {
        beginPlaybackFromIndex(idx);
    }
}
dom.wordPopover.addEventListener('touchend', activateWordPopover, { passive: false });
dom.wordPopover.addEventListener('click',    activateWordPopover);

// Any tap in the MAIN document outside the popover dismisses it. Taps inside
// the EPUB iframe don't bubble here — those are handled by the iframe's own
// listeners, which re-show the popover on a word or hide it on empty space.
document.addEventListener('pointerdown', (e) => {
    if (!dom.wordPopover.classList.contains('visible')) return;
    if (dom.wordPopover.contains(e.target)) return;
    hideWordPopover();
}, true);

// ── EPUB Tap Overlay Setup ────────────────────────────────────────────────────
//
// This is the PRIMARY touch handler for EPUB word taps on iOS.
//
// Why: epub.js installs gesture listeners on the iframe's window in the
// capture phase, consuming touchstart/touchend before our delegated handlers
// on the iframe body/document ever see them. Fighting inside the iframe is
// unreliable. Instead we place a transparent div (#epubTapOverlay) in the
// PARENT document, directly above the iframe (z-index 6; nav buttons are 10).
// Touches on the overlay fire in the parent-document context — completely
// outside epub.js's reach. We translate the parent-viewport coordinates to
// the iframe's viewport coordinate space and use elementFromPoint /
// caretRangeFromPoint on the iframe's document to find the word span.
//
// The overlay is shown/hidden when entering/leaving EPUB mode.
//
(function setupEpubTapOverlay() {
    let oTouchStartX = 0, oTouchStartY = 0, oTouchMoved = false;

    dom.epubTapOverlay.addEventListener('touchstart', (e) => {
        oTouchStartX = e.touches[0].clientX;
        oTouchStartY = e.touches[0].clientY;
        oTouchMoved  = false;
    }, { passive: true });

    dom.epubTapOverlay.addEventListener('touchmove', (e) => {
        if (Math.abs(e.touches[0].clientX - oTouchStartX) > 6 ||
            Math.abs(e.touches[0].clientY - oTouchStartY) > 6) {
            oTouchMoved = true;
        }
    }, { passive: true });

    dom.epubTapOverlay.addEventListener('touchend', (e) => {
        if (oTouchMoved) { hideWordPopover(); return; }

        // Suppress the 300 ms synthetic click so it doesn't also trigger
        // the overlay's click handler below.
        e.preventDefault();

        if (!appState.isEpubActive) return;

        const touch = e.changedTouches[0];

        // epub.js creates one iframe per rendition (paginated mode reuses it
        // across page turns). querySelector is called fresh each touchend so
        // we always get the current iframe even if epub.js rebuilt it.
        const iframe = dom.epubMode.querySelector('iframe');
        if (!iframe) { hideWordPopover(); return; }

        const iframeDoc = iframe.contentDocument;
        if (!iframeDoc) { hideWordPopover(); return; }

        // Translate parent-viewport coords → iframe-internal coords.
        // getBoundingClientRect() on the iframe element is always in the
        // parent document's viewport space regardless of epub.js transforms.
        const fr  = iframe.getBoundingClientRect();
        const iX  = touch.clientX - fr.left;
        const iY  = touch.clientY - fr.top;

        // Strategy 1: elementFromPoint respects CSS transforms, so it
        // correctly resolves the visible column in paginated-column layouts.
        let el = iframeDoc.elementFromPoint(iX, iY);
        let wordSpan = el ? el.closest('.wf-speech-word') : null;

        // Strategy 2: caretRangeFromPoint catches sub-pixel gaps between
        // glyphs where elementFromPoint falls through to the body.
        if (!wordSpan && iframeDoc.caretRangeFromPoint) {
            const range = iframeDoc.caretRangeFromPoint(iX, iY);
            if (range) {
                const node = range.startContainer;
                el = (node.nodeType === Node.TEXT_NODE) ? node.parentElement : node;
                wordSpan = el ? el.closest('.wf-speech-word') : null;
            }
        }

        if (wordSpan) {
            showPopoverForSpan(wordSpan, iframeDoc);
        } else {
            hideWordPopover();
        }
    }, { passive: false });

    // Desktop / pointer-device fallback.
    // On iOS the touchend handler calls e.preventDefault() which suppresses
    // this synthetic click, so there is no double-fire on mobile.
    dom.epubTapOverlay.addEventListener('click', (e) => {
        if (!appState.isEpubActive) return;

        const iframe = dom.epubMode.querySelector('iframe');
        if (!iframe) return;

        const iframeDoc = iframe.contentDocument;
        if (!iframeDoc) return;

        const fr = iframe.getBoundingClientRect();
        const el = iframeDoc.elementFromPoint(e.clientX - fr.left, e.clientY - fr.top);
        const wordSpan = el ? el.closest('.wf-speech-word') : null;

        if (wordSpan) {
            showPopoverForSpan(wordSpan, iframeDoc);
        } else {
            hideWordPopover();
        }
    });
})();

// ── Rendering & Highlighting ──────────────────────────────────────────────────

/**
 * renderPlainTextForReading — wraps every word in a <span> for
 * click/tap-to-read. Uses attachWordTapHandler() for delegation instead
 * of per-span onclick, which is more performant and iOS-reliable.
 */
function renderPlainTextForReading() {
    if (appState.isEpubActive) return;

    const text        = dom.plainTextMode.value;
    appState.fullText = text;
    dom.plainTextMode.style.display    = 'none';
    dom.renderedTextMode.style.display = 'block';
    dom.renderedTextMode.innerHTML     = '';

    const parts      = text.split(/(\s+)/); // preserve whitespace tokens
    let currentIndex = 0;
    appState.wordMap = [];

    parts.forEach(part => {
        if (!part.trim()) {
            dom.renderedTextMode.appendChild(document.createTextNode(part));
            currentIndex += part.length;
            return;
        }

        const span       = document.createElement('span');
        span.className   = 'wf-speech-word';
        span.textContent = part;
        const start      = currentIndex;
        const end        = currentIndex + part.length;
        span.dataset.start = start;
        span.dataset.end   = end;
        // iOS Safari tap-target hack: without an onclick attribute (even an
        // empty one) iOS will not fire tap/click events on non-interactive
        // elements like <span>, even with cursor:pointer in CSS.
        span.setAttribute('onclick', 'void(0)');

        dom.renderedTextMode.appendChild(span);
        appState.wordMap.push({ span, start, end });
        currentIndex = end;
    });

    // Attach ONE delegated handler to the container — not per-span
    attachWordTapHandler(dom.renderedTextMode);
    updateStats();
}

/**
 * syncVisibleEpubText — walks the EPUB iframe's text nodes, wraps every
 * word in a span, builds fullText and wordMap in one pass so character
 * indices are guaranteed to match what onboundary reports.
 *
 * Uses attachWordTapHandler(body) for iOS-reliable delegation instead of
 * per-span click listeners.
 */
function syncVisibleEpubText() {
    if (!appState.epubRendition) return;

    const contents = appState.epubRendition.getContents()[0];
    if (!contents || !contents.document) return;

    hideWordPopover(); // the page changed — any anchored popover is now stale
    cancelCurrentSpeech();
    appState.globalCharIndex = 0;

    const doc  = contents.document;
    const body = doc.body;
    if (!body) return;

    // epub.js paginated mode reuses the same iframe document across page turns
    // within a chapter (it CSS-columns the full chapter text). Any spans we
    // injected on a previous pass are still in the DOM, which causes the text-node
    // walker below to skip them (guard: don't recurse into .wf-speech-word).
    // Unwrap them first so we get fresh text nodes to walk.
    body.querySelectorAll('.wf-speech-word').forEach(span => {
        const parent = span.parentNode;
        if (parent) parent.replaceChild(doc.createTextNode(span.textContent), span);
    });
    // Merge adjacent text nodes created by the replacements above
    body.normalize();

    appState.wordMap = [];
    let fullText     = '';

    function injectWordSpans(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            const raw    = node.textContent;
            const parent = node.parentNode;
            if (!raw || !parent) return;

            const fragment = doc.createDocumentFragment();
            const tokens   = raw.split(/(\s+)/);

            tokens.forEach(token => {
                if (!token) return;

                if (/^\s+$/.test(token)) {
                    fragment.appendChild(doc.createTextNode(token));
                    fullText += token;
                } else {
                    const span = doc.createElement('span');
                    span.className = 'wf-speech-word';
                    const start = fullText.length;
                    const end   = start + token.length;
                    span.textContent   = token;
                    span.dataset.start = start;
                    span.dataset.end   = end;
                    // iOS tap-target hack (same as plain-text mode — see note there)
                    span.setAttribute('onclick', 'void(0)');

                    fragment.appendChild(span);
                    appState.wordMap.push({ span, start, end });
                    fullText += token;
                }
            });

            parent.replaceChild(fragment, node);

        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName.toUpperCase();
            if (['SCRIPT','STYLE','NOSCRIPT','SVG'].includes(tag)) return;
            if (node.classList && node.classList.contains('wf-speech-word')) return;
            // Snapshot before mutating the live NodeList
            Array.from(node.childNodes).forEach(child => injectWordSpans(child));
        }
    }

    Array.from(body.childNodes).forEach(child => injectWordSpans(child));
    appState.fullText = fullText;

    // Inject highlight + touch CSS into the iframe document.
    // We always overwrite (not guard with a missing-element check) so that
    // epub.js stylesheet injections that fire AFTER relocated cannot undo our rules.
    const STYLE_ID   = 'wf-tts-styles';
    const existingEl = doc.getElementById(STYLE_ID);
    const styleEl    = existingEl || doc.createElement('style');
    styleEl.id        = STYLE_ID;
    styleEl.textContent = `
        body {
            -webkit-user-select: none;
            user-select: none;
        }
        .wf-speech-word {
            /* cursor:pointer is the primary signal iOS Safari uses to decide
               whether an element should receive tap events. */
            cursor: pointer !important;
            border-radius: 3px;
            touch-action: manipulation;
            -webkit-tap-highlight-color: transparent;
            /* Ensure epub.js reader styles cannot accidentally disable taps
               by setting pointer-events:none on a parent or the spans themselves. */
            pointer-events: auto !important;
        }
        .wf-speech-word:active { background: rgba(0,122,255,0.10) !important; }
        .active-word     { background-color: #ffeb3b !important; font-weight: bold !important; }
        .active-sentence { background-color: #e3f2fd !important; }
    `;
    if (!existingEl) {
        (doc.head || doc.documentElement).appendChild(styleEl);
    }

    // Primary: delegated handler on the body (works for desktop + pointer events).
    // attachWordTapHandler() guards against re-attachment with _wfTapAttached,
    // and the delegated handler works correctly for freshly-injected spans
    // because it resolves targets dynamically via elementFromPoint / caretRangeFromPoint.
    attachWordTapHandler(body);

    // Secondary: document-level touchend / click using changedTouches[0] coordinates.
    //
    // epub.js sometimes installs its own touch handlers on the iframe body and
    // calls stopPropagation(), which swallows body-level touchend events before
    // our delegated handler sees them. Attaching to the iframe's *document* sits
    // above that layer and receives events that bubbled past the body capture phase.
    //
    // We guard with _wfDocTapAttached so we attach only once per iframe document
    // (the guard survives epub.js page turns when the document object is reused).
    if (!doc._wfDocTapAttached) {
        doc._wfDocTapAttached = true;

        // Shared helper: resolve the tapped word span from a coordinate pair.
        // Uses two strategies to handle iOS's varied hit-test quirks.
        function wordSpanAtCoords(clientX, clientY) {
            // 1. elementFromPoint — always returns an Element, never a Text node
            let el = doc.elementFromPoint(clientX, clientY);
            let target = el ? el.closest('.wf-speech-word') : null;

            // 2. caretRangeFromPoint — catches sub-pixel gaps where elementFromPoint
            //    returns the containing block rather than the inline span
            if (!target && doc.caretRangeFromPoint) {
                const range = doc.caretRangeFromPoint(clientX, clientY);
                if (range) {
                    const node = range.startContainer;
                    el = (node.nodeType === Node.TEXT_NODE) ? node.parentElement : node;
                    target = el ? el.closest('.wf-speech-word') : null;
                }
            }
            return target;
        }

        let docTouchMoved  = false;
        let docTouchStartX = 0;
        let docTouchStartY = 0;

        doc.addEventListener('touchstart', (e) => {
            docTouchStartX = e.touches[0].clientX;
            docTouchStartY = e.touches[0].clientY;
            docTouchMoved  = false;
        }, { passive: true });

        doc.addEventListener('touchmove', (e) => {
            if (Math.abs(e.touches[0].clientX - docTouchStartX) > 6 ||
                Math.abs(e.touches[0].clientY - docTouchStartY) > 6) {
                docTouchMoved = true;
            }
        }, { passive: true });

        doc.addEventListener('touchend', (e) => {
            if (docTouchMoved) return;
            // Use the touch lift-point, not the (potentially stale) e.target
            const touch  = e.changedTouches[0];
            const target = wordSpanAtCoords(touch.clientX, touch.clientY);
            // Tap on empty space inside the iframe dismisses the popover.
            if (!target) { hideWordPopover(); return; }
            e.preventDefault();
            // New UX: reveal the "Start from here" popover; speech starts from it.
            showPopoverForSpan(target, doc);
        }, { passive: false });

        // Mouse / stylus fallback for the iframe document (desktop EPUB reading)
        doc.addEventListener('click', (e) => {
            const target = wordSpanAtCoords(e.clientX, e.clientY);
            if (!target) { hideWordPopover(); return; }
            showPopoverForSpan(target, doc);
        });
    }

    updateStats();
    updateProgress();
    updatePlaybackUI(); // ensures nav buttons reflect isEpubActive state
    setStatus("EPUB page ready — tap a word or press Play");
}

/**
 * clearHighlights — must query BOTH the main document and the EPUB iframe
 * document, since they are separate DOM trees.
 */
function clearHighlights() {
    document.querySelectorAll('.active-word, .active-sentence').forEach(el => {
        el.classList.remove('active-word', 'active-sentence');
    });

    if (appState.isEpubActive && appState.epubRendition) {
        try {
            const contents = appState.epubRendition.getContents()[0];
            if (contents && contents.document) {
                contents.document.querySelectorAll('.active-word, .active-sentence').forEach(el => {
                    el.classList.remove('active-word', 'active-sentence');
                });
            }
        } catch (_) { /* iframe may be mid-navigation */ }
    }
}

/**
 * syncHighlights — looks up the active span via wordMap (direct DOM refs,
 * works for both main-doc spans and iframe spans) and applies active-word.
 */
function syncHighlights() {
    requestAnimationFrame(() => {
        clearHighlights();
        const idx    = appState.globalCharIndex;
        const active = appState.wordMap.find(w => idx >= w.start && idx < w.end);
        if (active) {
            active.span.classList.add('active-word');
            active.span.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    });
}

// ── Bottom Sheet Management ───────────────────────────────────────────────────

let activeSheet = null;

function openSheet(sheet) {
    hideWordPopover(); // a stale popover would float over the sheet
    if (activeSheet && activeSheet !== sheet) {
        activeSheet.classList.remove('open');
    }
    sheet.classList.add('open');
    dom.sheetOverlay.classList.add('visible');
    activeSheet = sheet;
}

function closeSheet() {
    if (activeSheet) {
        activeSheet.style.transform = ''; // reset any in-progress drag offset
        activeSheet.classList.remove('open');
        activeSheet = null;
    }
    dom.sheetOverlay.classList.remove('visible');
}

// Tap overlay to dismiss
dom.sheetOverlay.addEventListener('click', closeSheet);

// Done buttons (both sheets share the same class)
document.querySelectorAll('.sheet-done-btn').forEach(btn => {
    btn.addEventListener('click', closeSheet);
});

// ── Sheet Swipe-to-Dismiss ────────────────────────────────────────────────────
//
// Dragging the handle row downward by 80+ px dismisses the sheet.
// We intercept touch on the handle row only (not the scroll area) so
// normal list scrolling is unaffected.
//
function setupSheetDrag(handleEl, sheetEl) {
    let startY     = 0;
    let dragDeltaY = 0;
    let dragging   = false;

    handleEl.addEventListener('touchstart', (e) => {
        startY     = e.touches[0].clientY;
        dragDeltaY = 0;
        dragging   = true;
        sheetEl.style.transition = 'none'; // instant follow during drag
    }, { passive: true });

    handleEl.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        dragDeltaY = Math.max(0, e.touches[0].clientY - startY);
        sheetEl.style.transform = `translateY(${dragDeltaY}px)`;
    }, { passive: true });

    handleEl.addEventListener('touchend', () => {
        if (!dragging) return;
        dragging = false;
        sheetEl.style.transition = ''; // restore CSS transition
        if (dragDeltaY > 80) {
            closeSheet();
        } else {
            sheetEl.style.transform = ''; // snap back
        }
        dragDeltaY = 0;
    }, { passive: true });
}

setupSheetDrag(dom.settingsHandle, dom.settingsSheet);
setupSheetDrag(dom.tocHandle,      dom.tocSheet);

// ── Main Event Listeners ──────────────────────────────────────────────────────

// Top bar
dom.menuBtn.addEventListener('click', () => openSheet(dom.tocSheet));
dom.settingsToggleBtn.addEventListener('click', () => openSheet(dom.settingsSheet));

// Playback — single toggle button: Play (idle) → Pause (speaking) → Resume (paused)
dom.playToggleBtn.addEventListener('click', () => {
    hideWordPopover();

    if (appState.playbackState === 'speaking') {
        pauseSpeech();
        return;
    }

    if (appState.playbackState === 'paused') {
        resumeSpeech();
        return;
    }

    // idle → start from pendingStartIndex (set by "Start from here" popover),
    // or from globalCharIndex (0 after a page turn = top of current page).
    if (!appState.isEpubActive && dom.plainTextMode.value.trim() !== '') {
        renderPlainTextForReading();
    }
    const idx = (appState.pendingStartIndex !== null) ? appState.pendingStartIndex : appState.globalCharIndex;
    appState.pendingStartIndex = null;
    beginPlaybackFromIndex(idx);
});

// Scrolling the rendered text moves the words out from under a fixed-position
// popover, so dismiss it. (EPUB page turns are handled via 'relocated'.)
dom.renderedTextMode.addEventListener('scroll', hideWordPopover, { passive: true });

// Plain text edit
dom.plainTextMode.addEventListener('input', () => {
    appState.globalCharIndex = 0;
    updateStats();
    saveSession();
});

// Speed
dom.speedRange.addEventListener('input', (e) => {
    dom.speedValue.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
    updateStats();
    saveSession();
});

// Keyboard shortcut: Spacebar → pause / resume
document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' &&
        e.target.tagName !== 'TEXTAREA' &&
        e.target.tagName !== 'INPUT') {
        e.preventDefault();
        if (appState.playbackState === 'speaking') pauseSpeech();
        else if (appState.playbackState === 'paused') resumeSpeech();
    }
});

// Clean shutdown on unload
window.addEventListener('pagehide',     () => window.speechSynthesis.cancel());
window.addEventListener('beforeunload', () => window.speechSynthesis.cancel());

// ── Init ──────────────────────────────────────────────────────────────────────
updateStats();
updatePlaybackUI();
updateWakeLockUI();
