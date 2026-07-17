'use strict';
console.log("TTS Reader: initializing.");

// ── PWA assets ────────────────────────────────────────────────────────────────
(function injectPwaAssets() {
    try {
        const SZ = 512;
        const c = document.createElement('canvas');
        c.width = c.height = SZ;
        const ctx = c.getContext('2d');
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
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath();
        ctx.moveTo(170, 160);
        ctx.lineTo(170, 352);
        ctx.lineTo(340, 256);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath(); ctx.arc(340, 256, 60,  -0.8, 0.8); ctx.stroke();
        ctx.beginPath(); ctx.arc(340, 256, 105, -1.0, 1.0); ctx.stroke();
        const iconLink = document.createElement('link');
        iconLink.rel   = 'apple-touch-icon';
        iconLink.sizes = '512x512';
        iconLink.href  = c.toDataURL('image/png');
        document.head.appendChild(iconLink);
    } catch (_) {}

    try {
        const manifest = {
            name: 'TTS EPUB Reader', short_name: 'TTS Reader',
            description: 'Offline text-to-speech reader for EPUB and plain text',
            display: 'standalone', background_color: '#f2f2f7',
            theme_color: '#007AFF', orientation: 'portrait-primary', start_url: '.'
        };
        const blob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
        const mLink = document.createElement('link');
        mLink.rel  = 'manifest';
        mLink.href = URL.createObjectURL(blob);
        document.head.appendChild(mLink);
    } catch (_) {}
})();

// ── iOS detection ─────────────────────────────────────────────────────────────
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ── DOM References ────────────────────────────────────────────────────────────
const dom = {
    menuBtn:            document.getElementById('menuBtn'),
    wakeLockBtn:        document.getElementById('wakeLockBtn'),
    statusMessage:      document.getElementById('statusMessage'),
    plainTextMode:      document.getElementById('plainTextMode'),
    renderedTextMode:   document.getElementById('renderedTextMode'),
    epubMode:           document.getElementById('epubMode'),
    readingProgress:    document.getElementById('readingProgress'),
    progressPercentage: document.getElementById('progressPercentage'),
    prevBtn:            document.getElementById('prevBtn'),
    playToggleBtn:      document.getElementById('playToggleBtn'),
    nextBtn:            document.getElementById('nextBtn'),
    settingsToggleBtn:  document.getElementById('settingsToggleBtn'),
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
    tocSheet:           document.getElementById('tocSheet'),
    tocHandle:          document.getElementById('tocHandle'),
    tocContainer:       document.getElementById('tocContainer'),
    sheetOverlay:       document.getElementById('sheetOverlay'),
    wordPopover:        document.getElementById('wordPopover'),
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
    wordMap:           [],
    sentenceMap:       [],
    activeUtterance:   null,
    activeRequestId:   0,
    playbackChunks:    [],
    currentChunkIndex: 0,
    voiceStartTimeout: null,
    pendingStartIndex: null,
    autoResumeAfterPageTurn: false
};

// ── Storage Helpers ───────────────────────────────────────────────────────────
const storageHelpers = {
    get(key, defaultValue) {
        try {
            const item = window.localStorage.getItem(key);
            return item ? JSON.parse(item) : defaultValue;
        } catch (e) { return defaultValue; }
    },
    set(key, value) {
        try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    }
};

// ── Persistence & Session ─────────────────────────────────────────────────────
function setStatus(message) { dom.statusMessage.textContent = message; }

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
    try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(langCode.split('-')[0]) || langCode; }
    catch (_) { return langCode; }
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
let wakeLock       = null;
let wakeLockWanted = false;

async function acquireWakeLock() {
    if (!wakeLockWanted)           return;
    if (!('wakeLock' in navigator)) return;
    if (wakeLock)                  return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; updateWakeLockUI(); });
        updateWakeLockUI();
    } catch (err) {
        console.warn('Wake lock request failed:', err.name, err.message);
    }
}

function releaseWakeLock() { if (wakeLock) wakeLock.release(); }

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

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && appState.playbackState === 'speaking') {
        acquireWakeLock();
    }
});

dom.wakeLockBtn.addEventListener('click', async () => {
    if (wakeLock) {
        wakeLockWanted = false;
        releaseWakeLock();
    } else {
        wakeLockWanted = true;
        await acquireWakeLock();
        if (!wakeLock) setStatus("Wake Lock not available on this device");
    }
    updateWakeLockUI();
});

// ── Playback Engine ───────────────────────────────────────────────────────────

const MAX_CHUNK_CHARS = 900;

function createPlaybackChunks(text, startIndex = 0) {
    const textToChunk = text.substring(startIndex);
    if (!textToChunk.trim()) return [];

    const chunks     = [];
    const sentenceRx = /[^.!?]*[.!?]+\s*|[^.!?]+$/g;
    let match;

    while ((match = sentenceRx.exec(textToChunk)) !== null) {
        const sentence      = match[0];
        const sentenceStart = startIndex + match.index;

        if (sentence.length <= MAX_CHUNK_CHARS) {
            chunks.push({ text: sentence, offsetInFull: sentenceStart });
        } else {
            let charPos = 0;
            while (charPos < sentence.length) {
                let end = Math.min(charPos + MAX_CHUNK_CHARS, sentence.length);
                if (end < sentence.length) {
                    const lastSpace = sentence.lastIndexOf(' ', end);
                    if (lastSpace > charPos) end = lastSpace + 1;
                }
                if (end <= charPos) end = charPos + MAX_CHUNK_CHARS;
                chunks.push({ text: sentence.substring(charPos, end), offsetInFull: sentenceStart + charPos });
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
        icon.textContent  = '⏸'; label.textContent = 'Pause';
        btn.classList.add('is-speaking'); btn.disabled = false;
    } else if (s === 'paused') {
        icon.textContent  = '▶'; label.textContent = 'Resume';
        btn.classList.add('is-paused'); btn.disabled = false;
    } else if (s === 'starting') {
        icon.textContent  = '▶'; label.textContent = 'Play';
        btn.disabled = true;
    } else {
        icon.textContent  = '▶'; label.textContent = 'Play';
        btn.disabled = false;
    }

    const navEnabled = appState.isEpubActive && !!appState.epubRendition;
    dom.prevBtn.disabled = !navEnabled;
    dom.nextBtn.disabled = !navEnabled;

    const labels = { idle: 'Ready', starting: 'Loading…', speaking: 'Speaking', paused: 'Paused' };
    dom.statusMessage.textContent   = labels[s] || s;
    dom.statusMessage.dataset.state = s;
}

function cancelCurrentSpeech() {
    clearTimeout(appState.voiceStartTimeout);
    appState.voiceStartTimeout = null;
    window.speechSynthesis.cancel();
    releaseWakeLock();
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
    releaseWakeLock();
    updatePlaybackUI();
    saveSession();
}

function resumeSpeech() {
    if (appState.playbackState !== 'paused') return;
    if (isIOS) {
        window.speechSynthesis.cancel();
        appState.activeRequestId++;
        appState.playbackChunks    = [];
        appState.currentChunkIndex = 0;
        appState.playbackState     = 'idle';
        clearHighlights();
        updatePlaybackUI();
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
 * finishPageReading — called when TTS exhausts all visible-page chunks.
 * Stops speech cleanly WITHOUT clearing highlights or resetting globalCharIndex,
 * so the user sees exactly where audio ended before they press ❯.
 * Never calls epubRendition.next() — page turn is always manual.
 */
function finishPageReading() {
    clearTimeout(appState.voiceStartTimeout);
    appState.voiceStartTimeout = null;
    window.speechSynthesis.cancel();
    releaseWakeLock();
    appState.activeRequestId++;
    appState.playbackState     = 'idle';
    appState.activeUtterance   = null;
    appState.playbackChunks    = [];
    appState.currentChunkIndex = 0;
    // Intentionally omit clearHighlights() — last word stays highlighted.
    // Intentionally omit globalCharIndex reset — position is preserved.
    updatePlaybackUI();
    setStatus("Page done — press ❯ Next to continue");
}

/**
 * speakChunk — speaks one chunk. When all chunks are exhausted:
 *   • EPUB mode  → finishPageReading() (graceful stop, no auto page-turn)
 *   • Plain text → stopSpeech() (reset to beginning for next play)
 */
function speakChunk() {
    if (appState.currentChunkIndex >= appState.playbackChunks.length) {
        if (appState.isEpubActive) {
            finishPageReading();
        } else {
            stopSpeech();
            setStatus("Finished reading");
        }
        return;
    }

    const chunk       = appState.playbackChunks[appState.currentChunkIndex];
    const textToSpeak = chunk.text;
    const chunkOffset = chunk.offsetInFull;

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
        acquireWakeLock();
        updatePlaybackUI();
    };

    utterance.onboundary = (event) => {
        if (currentReqId !== appState.activeRequestId) return;
        if (event.name !== 'word') return;
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
        if (event.error !== 'canceled' && event.error !== 'interrupted') {
            console.error("Speech error:", event);
            resetPlaybackState();
            setStatus("Speech error — try another voice");
        }
    };

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

function startSpeech() {
    if (!appState.fullText) return;
    appState.playbackChunks    = createPlaybackChunks(appState.fullText, appState.globalCharIndex);
    appState.currentChunkIndex = 0;
    speakChunk();
}

// ── EPUB Loading & Parsing ────────────────────────────────────────────────────

dom.epubInput.addEventListener('change', (e) => {
    closeSheet();
    const file = e.target.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.epub')) { setStatus("Please select a .epub file."); return; }
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
            dom.epubTapOverlay.style.display   = 'none';
            appState.isEpubActive = true;

            if (appState.epubBook) appState.epubBook.destroy();

            appState.epubBook = ePub(undefined, { replacements: 'none' });
            appState.epubBook.open(arrayBuffer, 'binary');

            appState.epubRendition = appState.epubBook.renderTo(dom.epubMode, {
                width: '100%', height: '100%',
                flow: 'paginated', spread: 'none', allowScriptedContent: false
            });

            appState.epubRendition.hooks.content.register((contents) => {
                ['script','iframe','object','embed'].forEach(tag => {
                    contents.document.querySelectorAll(tag).forEach(el => el.remove());
                });
            });

            appState.epubBook.loaded.navigation.then(nav => buildToc(nav.toc));

            appState.epubRendition.on('relocated', () => syncVisibleEpubText());

            appState.epubRendition.display().then(() => {
                clearTimeout(renderTimeout);
                dom.epubTapOverlay.style.display = 'block';
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
        dom.epubMode.style.display       = 'none';
        dom.epubTapOverlay.style.display = 'none';
        updatePlaybackUI();

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
            const html    = await chapterFile.async("string");
            const chapDoc = parser.parseFromString(html, "text/html");
            ['script','iframe','object','embed'].forEach(tag => {
                chapDoc.querySelectorAll(tag).forEach(el => el.remove());
            });
            const text = chapDoc.body ? chapDoc.body.textContent : chapDoc.documentElement.textContent;
            extractedText += text.replace(/\s+/g, ' ') + "\n\n";
        }

        if (!extractedText.trim()) throw new Error("No readable text found in spine.");

        dom.plainTextMode.value         = extractedText;
        dom.plainTextMode.style.display = 'block';
        appState.fullText               = extractedText;
        appState.globalCharIndex        = 0;
        dom.tocContainer.innerHTML      = '<i>TOC unavailable in fallback mode</i>';
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

dom.prevBtn.addEventListener('click', () => {
    if (!appState.epubRendition) return;
    if (appState.playbackState === 'speaking') appState.autoResumeAfterPageTurn = true;
    appState.epubRendition.prev();
});
dom.nextBtn.addEventListener('click', () => {
    if (!appState.epubRendition) return;
    if (appState.playbackState === 'speaking') appState.autoResumeAfterPageTurn = true;
    appState.epubRendition.next();
});

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

function attachWordTapHandler(container) {
    if (container._wfTapAttached) return;
    container._wfTapAttached = true;

    const ownerDoc = container.ownerDocument || document;

    let touchMoved  = false;
    let touchStartX = 0;
    let touchStartY = 0;

    container.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchMoved  = false;
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
        if (Math.abs(e.touches[0].clientX - touchStartX) > 6 ||
            Math.abs(e.touches[0].clientY - touchStartY) > 6) {
            touchMoved = true;
        }
    }, { passive: true });

    container.addEventListener('touchend', (e) => {
        if (touchMoved) return;

        const touch = e.changedTouches[0];
        let target  = null;

        if (touch) {
            const el = ownerDoc.elementFromPoint(touch.clientX, touch.clientY);
            target = el ? el.closest('.wf-speech-word') : null;
        }
        if (!target) {
            const t = e.target;
            if (t && t.nodeType === Node.ELEMENT_NODE) {
                target = t.closest('.wf-speech-word');
            } else if (t && t.nodeType === Node.TEXT_NODE && t.parentElement) {
                target = t.parentElement.closest('.wf-speech-word');
            }
        }
        if (!target && touch && ownerDoc.caretRangeFromPoint) {
            const range = ownerDoc.caretRangeFromPoint(touch.clientX, touch.clientY);
            if (range) {
                const node = range.startContainer;
                const el   = (node.nodeType === Node.TEXT_NODE) ? node.parentElement : node;
                target = el ? el.closest('.wf-speech-word') : null;
            }
        }

        if (!target) { hideWordPopover(); return; }
        e.preventDefault();
        e.stopPropagation();
        showPopoverForSpan(target, ownerDoc);
    }, { passive: false });

    container.addEventListener('click', (e) => {
        const el = e.target;
        const target = (el && el.closest) ? el.closest('.wf-speech-word') : null;
        if (!target) { hideWordPopover(); return; }
        showPopoverForSpan(target, ownerDoc);
    });
}

// ── Floating "Start from here" Popover ───────────────────────────────────────

function getSpanRectInMainViewport(span, ownerDoc) {
    const r = span.getBoundingClientRect();
    if (ownerDoc && ownerDoc !== document) {
        let frameEl = null;
        try { if (ownerDoc.defaultView) frameEl = ownerDoc.defaultView.frameElement; } catch (_) {}
        if (!frameEl && appState.isEpubActive) frameEl = dom.epubMode.querySelector('iframe');
        if (frameEl) {
            const fr = frameEl.getBoundingClientRect();
            return { left: fr.left + r.left, top: fr.top + r.top,
                     right: fr.left + r.right, bottom: fr.top + r.bottom,
                     width: r.width, height: r.height };
        }
    }
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

function showPopoverForSpan(span, ownerDoc) {
    const start = parseInt(span.dataset.start, 10);
    if (isNaN(start)) return;
    appState.pendingStartIndex = start;

    const rect = getSpanRectInMainViewport(span, ownerDoc);
    const pop  = dom.wordPopover;

    pop.classList.remove('hidden');

    const pw = pop.offsetWidth  || 150;
    const ph = pop.offsetHeight || 40;

    let left = rect.left + rect.width / 2 - pw / 2;
    let top  = rect.top - ph - 10;
    if (top < 8) top = rect.bottom + 10;

    const margin = 8;
    left = Math.max(margin, Math.min(left, window.innerWidth  - pw - margin));
    top  = Math.max(margin, Math.min(top,  window.innerHeight - ph - margin));

    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';
    requestAnimationFrame(() => pop.classList.add('visible'));
}

function hideWordPopover() {
    appState.pendingStartIndex = null;
    dom.wordPopover.classList.remove('visible');
}

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

document.addEventListener('pointerdown', (e) => {
    if (!dom.wordPopover.classList.contains('visible')) return;
    if (dom.wordPopover.contains(e.target)) return;
    hideWordPopover();
}, true);

// ── EPUB Tap Overlay Setup ────────────────────────────────────────────────────

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
        e.preventDefault();
        if (!appState.isEpubActive) return;

        const touch = e.changedTouches[0];
        const iframe = dom.epubMode.querySelector('iframe');
        if (!iframe) { hideWordPopover(); return; }

        const iframeDoc = iframe.contentDocument;
        if (!iframeDoc) { hideWordPopover(); return; }

        const fr = iframe.getBoundingClientRect();
        const iX = touch.clientX - fr.left;
        const iY = touch.clientY - fr.top;

        let el = iframeDoc.elementFromPoint(iX, iY);
        let wordSpan = el ? el.closest('.wf-speech-word') : null;

        if (!wordSpan && iframeDoc.caretRangeFromPoint) {
            const range = iframeDoc.caretRangeFromPoint(iX, iY);
            if (range) {
                const node = range.startContainer;
                el = (node.nodeType === Node.TEXT_NODE) ? node.parentElement : node;
                wordSpan = el ? el.closest('.wf-speech-word') : null;
            }
        }

        if (wordSpan) { showPopoverForSpan(wordSpan, iframeDoc); } else { hideWordPopover(); }
    }, { passive: false });

    dom.epubTapOverlay.addEventListener('click', (e) => {
        if (!appState.isEpubActive) return;
        const iframe = dom.epubMode.querySelector('iframe');
        if (!iframe) return;
        const iframeDoc = iframe.contentDocument;
        if (!iframeDoc) return;
        const fr = iframe.getBoundingClientRect();
        const el = iframeDoc.elementFromPoint(e.clientX - fr.left, e.clientY - fr.top);
        const wordSpan = el ? el.closest('.wf-speech-word') : null;
        if (wordSpan) { showPopoverForSpan(wordSpan, iframeDoc); } else { hideWordPopover(); }
    });
})();

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderPlainTextForReading() {
    if (appState.isEpubActive) return;

    const text        = dom.plainTextMode.value;
    appState.fullText = text;
    dom.plainTextMode.style.display    = 'none';
    dom.renderedTextMode.style.display = 'block';
    dom.renderedTextMode.innerHTML     = '';

    const parts      = text.split(/(\s+)/);
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
        span.setAttribute('onclick', 'void(0)');
        dom.renderedTextMode.appendChild(span);
        appState.wordMap.push({ span, start, end });
        currentIndex = end;
    });

    attachWordTapHandler(dom.renderedTextMode);
    updateStats();
}

/**
 * syncVisibleEpubText — rebuilds the word map for the currently-displayed
 * EPUB page. Uses a clone-process-swap pattern for performance, then
 * applies a viewport-visibility filter to restrict TTS and highlighting
 * to only the words actually visible on screen.
 *
 * Why the visibility filter is critical:
 *   epub.js paginated mode lays the full chapter out as horizontal CSS
 *   columns inside the iframe. The "current page" is the column whose
 *   bounding rect falls inside [0, 0, innerWidth, innerHeight] in the
 *   iframe's coordinate space. Without filtering, the word map would
 *   contain text from adjacent (off-screen) columns. When TTS highlights
 *   a word in an off-screen column, scrollIntoView (or even just class
 *   assignment) can force that column into view, shearing the layout into
 *   a broken split-screen. By restricting fullText and wordMap to
 *   visible-column spans only, TTS naturally stops at the page boundary
 *   and can never reference a hidden span.
 */
function syncVisibleEpubText() {
    if (!appState.epubRendition) return;

    const contents = appState.epubRendition.getContents()[0];
    if (!contents || !contents.document) return;

    hideWordPopover();

    // Capture auto-resume intent BEFORE cancelCurrentSpeech() resets playback state
    const shouldAutoResume = appState.autoResumeAfterPageTurn;
    appState.autoResumeAfterPageTurn = false;

    cancelCurrentSpeech();   // safe on idle engine; clears any stale highlights
    appState.globalCharIndex = 0;
    setStatus("Loading page…");

    const doc  = contents.document;
    const body = doc.body;
    if (!body) return;

    // Defer heavy DOM work one frame so epub.js's page-turn paint completes
    // first — the column transform is applied synchronously before 'relocated'
    // fires, so by the time the rAF callback runs the layout is stable and
    // getBoundingClientRect() returns valid viewport-relative coordinates.
    requestAnimationFrame(() => {

        // ── Phase 1: Off-screen clone ─────────────────────────────────────
        // Phase 0: Pre-swap visibility measurement.
        // Measure which character range is visible NOW, before touching the DOM.
        // epub.js's scroll/transform state is correct at this point. Parent-element
        // bounding rects serve as proxies for text node positions: if wf-speech-word
        // spans exist from a prior pass they give word-level granularity; otherwise
        // block elements give page-level granularity — both are measured before any
        // body swap, so they're always accurate.
        const iw = (doc.defaultView && doc.defaultView.innerWidth)  || body.clientWidth  || 0;
        const ih = (doc.defaultView && doc.defaultView.innerHeight) || body.clientHeight || 0;
        const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG']);

        const walkerPre = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        const preNodes  = [];
        let preText     = '';
        let wn;
        while ((wn = walkerPre.nextNode()) !== null) {
            let el = wn.parentElement, skip = false;
            while (el) {
                if (SKIP_TAGS.has(el.tagName && el.tagName.toUpperCase())) { skip = true; break; }
                el = el.parentElement;
            }
            if (skip) continue;
            preNodes.push({ start: preText.length, end: preText.length + wn.textContent.length, parentEl: wn.parentElement });
            preText += wn.textContent;
        }
        const preRects = preNodes.map(d => d.parentEl ? d.parentEl.getBoundingClientRect() : null);
        let preVisStart = -1, preVisEnd = -1;
        preRects.forEach((rect, i) => {
            if (!rect || (rect.width === 0 && rect.height === 0)) return;
            const cx = (rect.left + rect.right) / 2;
            const cy = (rect.top  + rect.bottom) / 2;
            if (cx >= 0 && cx < iw && cy >= 0 && cy < ih) {
                if (preVisStart === -1) preVisStart = preNodes[i].start;
                preVisEnd = preNodes[i].end;
            }
        });

        const clone = body.cloneNode(true);

        // ── Phase 2: Unwrap existing spans in the clone ───────────────────
        clone.querySelectorAll('.wf-speech-word').forEach(span => {
            span.replaceWith(doc.createTextNode(span.textContent));
        });
        clone.normalize();

        // ── Phase 3: Collect text nodes via native TreeWalker ─────────────
        const walker    = doc.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        let walkerNode;

        while ((walkerNode = walker.nextNode()) !== null) {
            let el   = walkerNode.parentElement;
            let skip = false;
            while (el) {
                if (SKIP_TAGS.has(el.tagName && el.tagName.toUpperCase())) { skip = true; break; }
                el = el.parentElement;
            }
            if (!skip) textNodes.push(walkerNode);
        }

        // ── Phase 4: Inject word spans on the clone (all off-screen) ──────
        let fullText = '';
        const wordMap = [];

        textNodes.forEach(textNode => {
            const raw    = textNode.textContent;
            const parent = textNode.parentNode;
            if (!raw || !parent) { fullText += raw || ''; return; }

            const fragment = doc.createDocumentFragment();
            const tokens   = raw.split(/(\s+)/);

            tokens.forEach(token => {
                if (!token) return;
                if (/^\s+$/.test(token)) {
                    fragment.appendChild(doc.createTextNode(token));
                    fullText += token;
                } else {
                    const span       = doc.createElement('span');
                    span.className   = 'wf-speech-word';
                    const start      = fullText.length;
                    const end        = start + token.length;
                    span.textContent = token;
                    span.dataset.start = start;
                    span.dataset.end   = end;
                    span.setAttribute('onclick', 'void(0)');
                    fragment.appendChild(span);
                    wordMap.push({ span, start, end });
                    fullText += token;
                }
            });

            parent.replaceChild(fragment, textNode);
        });

        // Phase 5: Atomic swap into the live body.
        const tempFrag = doc.createDocumentFragment();
        while (clone.firstChild) tempFrag.appendChild(clone.firstChild);
        body.textContent = '';
        body.appendChild(tempFrag);
        // Span refs in wordMap are now live in body (nodes were moved, not copied).

        // Phase 6: Map pre-measured visible range to rebuilt wordMap.
        // fullText and preText were built from the same text nodes in the same
        // traversal order, so character positions correspond 1:1 between them.
        // Using the pre-swap range avoids any scroll/transform state issues that
        // occur after the body swap.
        let firstVis = -1, lastVis = -1;
        if (preVisStart >= 0 && preVisEnd > preVisStart) {
            for (let i = 0; i < wordMap.length; i++) {
                if (wordMap[i].end > preVisStart && wordMap[i].start < preVisEnd) {
                    if (firstVis === -1) firstVis = i;
                    lastVis = i;
                }
            }
        }
        // Fallback if pre-swap measurement found nothing (iw/ih = 0 or all
        // rects zero-area): use full text so TTS still functions.

        const visCharStart  = firstVis >= 0 ? wordMap[firstVis].start : 0;
        const visCharEnd    = lastVis  >= 0 ? wordMap[lastVis].end   : fullText.length;
        const visibleText   = fullText.substring(visCharStart, visCharEnd);
        const visibleWordMap = [];
        if (firstVis >= 0) {
            for (let i = firstVis; i <= lastVis; i++) {
                const entry    = wordMap[i];
                const newStart = entry.start - visCharStart;
                const newEnd   = entry.end   - visCharStart;
                entry.span.dataset.start = newStart;
                entry.span.dataset.end   = newEnd;
                visibleWordMap.push({ span: entry.span, start: newStart, end: newEnd });
            }
        }
        appState.wordMap  = visibleWordMap;
        appState.fullText = visibleText;

        // ── Phase 7: Inject/refresh iframe CSS ────────────────────────────
        const STYLE_ID   = 'wf-tts-styles';
        const existingEl = doc.getElementById(STYLE_ID);
        const styleEl    = existingEl || doc.createElement('style');
        styleEl.id        = STYLE_ID;
        styleEl.textContent = `
            body { -webkit-user-select: none; user-select: none; }
            .wf-speech-word {
                cursor: pointer !important;
                border-radius: 3px;
                touch-action: manipulation;
                -webkit-tap-highlight-color: transparent;
                pointer-events: auto !important;
            }
            .wf-speech-word:active { background: rgba(0,122,255,0.10) !important; }
            .active-word     { background-color: #ffeb3b !important; font-weight: bold !important; }
            .active-sentence { background-color: #e3f2fd !important; }
        `;
        if (!existingEl) (doc.head || doc.documentElement).appendChild(styleEl);

        // ── Phase 8: Attach delegated touch/click handlers ────────────────
        attachWordTapHandler(body);

        if (!doc._wfDocTapAttached) {
            doc._wfDocTapAttached = true;

            function wordSpanAtCoords(clientX, clientY) {
                let el = doc.elementFromPoint(clientX, clientY);
                let target = el ? el.closest('.wf-speech-word') : null;
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

            let docTouchMoved = false, docTouchStartX = 0, docTouchStartY = 0;

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
                const touch  = e.changedTouches[0];
                const target = wordSpanAtCoords(touch.clientX, touch.clientY);
                if (!target) { hideWordPopover(); return; }
                e.preventDefault();
                showPopoverForSpan(target, doc);
            }, { passive: false });

            doc.addEventListener('click', (e) => {
                const target = wordSpanAtCoords(e.clientX, e.clientY);
                if (!target) { hideWordPopover(); return; }
                showPopoverForSpan(target, doc);
            });
        }

        updateStats();
        updateProgress();
        updatePlaybackUI();

        // Auto-resume: if the user clicked Next/Prev while TTS was speaking,
        // restart from the top of the newly-loaded page.
        if (shouldAutoResume && appState.fullText) {
            setStatus("Continuing…");
            appState.globalCharIndex = 0;
            clearTimeout(appState.voiceStartTimeout);
            if (isIOS) {
                // iOS WebKit: cancel() + speak() in the same tick silently drops
                // the utterance. Defer past the engine's cancel propagation.
                appState.voiceStartTimeout = setTimeout(() => {
                    appState.voiceStartTimeout = null;
                    startSpeech();
                }, 260);
            } else {
                startSpeech();
            }
        } else {
            setStatus("EPUB page ready — tap a word or press Play");
        }
    });
}

// ── Highlighting ──────────────────────────────────────────────────────────────

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
        } catch (_) {}
    }
}

/**
 * syncHighlights — applies .active-word to the span matching the current
 * char position. scrollIntoView is intentionally skipped in EPUB mode:
 * epub.js owns the scroll/transform position and calling scrollIntoView
 * on any span — even a visible one — can corrupt the column layout by
 * fighting with epub.js's own scroll management.
 */
function syncHighlights() {
    requestAnimationFrame(() => {
        clearHighlights();
        const idx    = appState.globalCharIndex;
        const active = appState.wordMap.find(w => idx >= w.start && idx < w.end);
        if (active) {
            active.span.classList.add('active-word');
            // Only scroll in plain-text mode; epub.js manages its own viewport.
            if (!appState.isEpubActive) {
                active.span.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    });
}

// ── Bottom Sheet Management ───────────────────────────────────────────────────

let activeSheet = null;

function openSheet(sheet) {
    hideWordPopover();
    if (activeSheet && activeSheet !== sheet) activeSheet.classList.remove('open');
    sheet.classList.add('open');
    dom.sheetOverlay.classList.add('visible');
    activeSheet = sheet;
}

function closeSheet() {
    if (activeSheet) {
        activeSheet.style.transform = '';
        activeSheet.classList.remove('open');
        activeSheet = null;
    }
    dom.sheetOverlay.classList.remove('visible');
}

dom.sheetOverlay.addEventListener('click', closeSheet);
document.querySelectorAll('.sheet-done-btn').forEach(btn => btn.addEventListener('click', closeSheet));

function setupSheetDrag(handleEl, sheetEl) {
    let startY = 0, dragDeltaY = 0, dragging = false;

    handleEl.addEventListener('touchstart', (e) => {
        startY = e.touches[0].clientY; dragDeltaY = 0; dragging = true;
        sheetEl.style.transition = 'none';
    }, { passive: true });

    handleEl.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        dragDeltaY = Math.max(0, e.touches[0].clientY - startY);
        sheetEl.style.transform = `translateY(${dragDeltaY}px)`;
    }, { passive: true });

    handleEl.addEventListener('touchend', () => {
        if (!dragging) return;
        dragging = false;
        sheetEl.style.transition = '';
        if (dragDeltaY > 80) { closeSheet(); } else { sheetEl.style.transform = ''; }
        dragDeltaY = 0;
    }, { passive: true });
}

setupSheetDrag(dom.settingsHandle, dom.settingsSheet);
setupSheetDrag(dom.tocHandle,      dom.tocSheet);

// ── Main Event Listeners ──────────────────────────────────────────────────────

dom.menuBtn.addEventListener('click', () => openSheet(dom.tocSheet));
dom.settingsToggleBtn.addEventListener('click', () => openSheet(dom.settingsSheet));

// Play toggle: idle → start from top of current page (globalCharIndex = 0
// after every page turn), speaking → pause, paused → resume.
// "Start from here" popover overrides globalCharIndex via pendingStartIndex.
dom.playToggleBtn.addEventListener('click', () => {
    hideWordPopover();
    if (appState.playbackState === 'speaking') { pauseSpeech(); return; }
    if (appState.playbackState === 'paused')   { resumeSpeech(); return; }
    if (!appState.isEpubActive && dom.plainTextMode.value.trim() !== '') {
        renderPlainTextForReading();
    }

    let idx;
    if (appState.pendingStartIndex !== null) {
        // User tapped a word via "Start from here" popover
        idx = appState.pendingStartIndex;
        appState.pendingStartIndex = null;
    } else if (appState.isEpubActive && appState.wordMap.length > 0) {
        // EPUB: always start from the first visible word on the current page.
        // wordMap[0].start === 0 after Phase 6 remapping, so this is explicit
        // rather than relying on globalCharIndex being correct.
        idx = appState.wordMap[0].start;
        appState.globalCharIndex = idx;
    } else {
        idx = appState.globalCharIndex;
    }

    beginPlaybackFromIndex(idx);
});

dom.renderedTextMode.addEventListener('scroll', hideWordPopover, { passive: true });

dom.plainTextMode.addEventListener('input', () => {
    appState.globalCharIndex = 0;
    updateStats();
    saveSession();
});

dom.speedRange.addEventListener('input', (e) => {
    dom.speedValue.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
    updateStats();
    saveSession();
});

document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        if (appState.playbackState === 'speaking') pauseSpeech();
        else if (appState.playbackState === 'paused') resumeSpeech();
    }
});

window.addEventListener('pagehide',     () => window.speechSynthesis.cancel());
window.addEventListener('beforeunload', () => window.speechSynthesis.cancel());

// ── Init ──────────────────────────────────────────────────────────────────────
updateStats();
updatePlaybackUI();
updateWakeLockUI();
