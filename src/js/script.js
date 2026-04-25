// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB hard cap for images

// ─── STATE ────────────────────────────────────────────────────────────────────
let currentMode = "pdf";
let selectedFile = null;
let compressedBlob = null;

// ─── MODE SWITCH ──────────────────────────────────────────────────────────────
function switchMode(mode) {
  currentMode = mode;
  clearFile();
  document.getElementById("tab-pdf").classList.toggle("active", mode === "pdf");
  document
    .getElementById("tab-img")
    .classList.toggle("active", mode === "image");
  document
    .getElementById("banner-pdf")
    .classList.toggle("hidden", mode !== "pdf");
  document
    .getElementById("banner-img")
    .classList.toggle("hidden", mode !== "image");
  const input = document.getElementById("fileInput");
  if (mode === "pdf") {
    input.accept = "application/pdf";
    document.getElementById("accepted-label").textContent = "PDF diterima";
  } else {
    input.accept = "image/*";
    document.getElementById("accepted-label").textContent =
      "JPG, JPEG, PNG, WebP, GIF, BMP, TIFF";
  }
}

// ─── FILE INPUT ───────────────────────────────────────────────────────────────
const fileInput = document.getElementById("fileInput");
const dropzone = document.getElementById("dropzone");

fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () =>
  dropzone.classList.remove("dragover"),
);
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

function handleFile(file) {
  if (!file) return;
  hideAll();
  if (currentMode === "pdf" && file.type !== "application/pdf") {
    showError("File harus berformat PDF. Pilih file .pdf yang valid.");
    return;
  }
  if (currentMode === "image" && !file.type.startsWith("image/")) {
    showError("File harus berupa gambar. Pilih format gambar yang didukung.");
    return;
  }
  selectedFile = file;
  document.getElementById("file-name").textContent = file.name;
  document.getElementById("file-size").textContent = formatBytes(file.size);
  document.getElementById("file-icon-box").textContent =
    currentMode === "pdf" ? "📄" : "🖼️";
  document.getElementById("file-info").classList.remove("hidden");
  document.getElementById("compressBtn").disabled = false;
  dropzone.style.opacity = "0.5";
  dropzone.style.pointerEvents = "none";
}

function clearFile() {
  selectedFile = null;
  fileInput.value = "";
  document.getElementById("file-info").classList.add("hidden");
  document.getElementById("compressBtn").disabled = true;
  dropzone.style.opacity = "";
  dropzone.style.pointerEvents = "";
  hideAll();
}

// ─── COMPRESS ENTRY ───────────────────────────────────────────────────────────
async function startCompress() {
  if (!selectedFile) return;
  hideAll();
  showProgress("Memulai kompresi...");

  const btn = document.getElementById("compressBtn");
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Memproses...';

  try {
    if (currentMode === "pdf") {
      compressedBlob = await compressPDF(selectedFile);
      // If pdf-lib made it larger (can happen with already-optimized PDFs), serve as-is
      if (compressedBlob.size >= selectedFile.size) {
        compressedBlob = new Blob([await selectedFile.arrayBuffer()], {
          type: "application/pdf",
        });
      }
      setProgress(100, "Selesai!");
      setTimeout(() => {
        hideProgress();
        showResults();
      }, 450);
    } else {
      // Image: check size first
      if (selectedFile.size <= MAX_IMAGE_BYTES) {
        hideProgress();
        document.getElementById("already-small").classList.remove("hidden");
        return;
      }
      compressedBlob = await compressImageTo5MB(selectedFile);
      setProgress(100, "Selesai!");
      setTimeout(() => {
        hideProgress();
        showResults();
      }, 450);
    }
  } catch (err) {
    hideProgress();
    showError(
      "Gagal memproses: " + (err.message || "Terjadi kesalahan tak terduga."),
    );
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 1v10M5 7l4 4 4-4" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 14v1a2 2 0 002 2h10a2 2 0 002-2v-1" stroke="white" stroke-width="2" stroke-linecap="round"/></svg> Kompresi Sekarang`;
  }
}

// ─── PDF COMPRESSION ──────────────────────────────────────────────────────────
// Strips all metadata and uses compressed object streams.
// Does NOT re-render pages — visual quality is 100% preserved.
async function compressPDF(file) {
  setProgress(10, "Membaca PDF...");
  const buf = await file.arrayBuffer();

  setProgress(25, "Memuat dokumen...");
  const { PDFDocument } = PDFLib;

  const doc = await PDFDocument.load(buf, {
    ignoreEncryption: true,
    updateMetadata: false,
  });

  setProgress(45, "Menghapus metadata...");

  // 🔥 Bersihin semua metadata
  try {
    doc.setTitle("");
  } catch {}
  try {
    doc.setAuthor("");
  } catch {}
  try {
    doc.setSubject("");
  } catch {}
  try {
    doc.setKeywords([]);
  } catch {}
  try {
    doc.setProducer("");
  } catch {}
  try {
    doc.setCreator("");
  } catch {}
  try {
    doc.setCreationDate(new Date(0));
  } catch {}
  try {
    doc.setModificationDate(new Date(0));
  } catch {}

  setProgress(65, "Mengompresi struktur PDF...");

  const compressedBytes = await doc.save({
    useObjectStreams: true,
    addDefaultPage: false,
    objectsPerTick: 50, // 🔥 bantu optimasi chunk
  });

  let resultBlob = new Blob([compressedBytes], {
    type: "application/pdf",
  });

  setProgress(85, "Validasi hasil...");

  // 🔥 IMPORTANT: kalau malah lebih besar → pakai original
  if (resultBlob.size >= file.size) {
    return new Blob([buf], { type: "application/pdf" });
  }

  return resultBlob;
}

// ─── IMAGE COMPRESSION (Binary-search to ≤5 MB) ───────────────────────────────
// Algorithm:
//   1. Load image onto canvas at full resolution.
//   2. Binary-search the minimum downscale factor (lo=0.02, hi=1.0)
//      such that canvas.toBlob('image/jpeg', 0.92) < MAX_IMAGE_BYTES.
//   3. JPEG quality fixed at 0.92 — near-perceptually-lossless; only resolution
//      is reduced, and only as much as needed to hit the target.
//   4. If even full resolution at q=0.92 fits (shouldn't happen since we
//      already checked > 5 MB), we wouldn't reach here.
async function compressImageTo5MB(file) {
  return new Promise((resolve, reject) => {
    setProgress(12, "Membaca gambar...");

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Gagal membaca file gambar."));

    reader.onload = (e) => {
      const img = new Image();

      img.onerror = () =>
        reject(new Error("Format gambar tidak dapat dibuka."));

      img.onload = async () => {
        const W = img.naturalWidth;
        const H = img.naturalHeight;

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        // ✅ FIX: RESOLUSI TETAP
        canvas.width = W;
        canvas.height = H;

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(img, 0, 0, W, H);

        setProgress(25, "Mengoptimalkan kualitas...");

        // 🔥 Binary search QUALITY (BUKAN SCALE)
        let lo = 0.3; // minimum quality
        let hi = 0.95; // max quality
        let bestBlob = null;

        for (let i = 0; i < 8; i++) {
          const quality = (lo + hi) / 2;

          const blob = await toBlob(canvas, "image/jpeg", quality);

          const prog = Math.round(25 + (i / 8) * 60);
          setProgress(
            prog,
            `Menyesuaikan kualitas... (${Math.round(quality * 100)}%)`,
          );

          if (blob.size <= MAX_IMAGE_BYTES) {
            bestBlob = blob;
            lo = quality; // coba naikkan kualitas
          } else {
            hi = quality; // terlalu besar → turunkan kualitas
          }
        }

        // fallback kalau tidak ketemu
        if (!bestBlob) {
          bestBlob = await toBlob(canvas, "image/jpeg", 0.7);
        }

        setProgress(92, "Finalisasi...");
        resolve(bestBlob);
      };

      img.src = e.target.result;
    };

    reader.readAsDataURL(file);
  });
}

// Promise wrapper for canvas.toBlob
function toBlob(canvas, mime, quality) {
  return new Promise((res, rej) => {
    canvas.toBlob(
      (b) => (b ? res(b) : rej(new Error("Gagal mengekspor gambar."))),
      mime,
      quality,
    );
  });
}

// ─── SHOW RESULTS ─────────────────────────────────────────────────────────────
function showResults() {
  const origSize = selectedFile.size;
  const compSize = compressedBlob.size;
  const saved = Math.max(0, origSize - compSize);
  const pct = Math.round((saved / origSize) * 100);

  document.getElementById("stat-original").textContent = formatBytes(origSize);
  document.getElementById("stat-compressed").textContent =
    formatBytes(compSize);
  document.getElementById("stat-saved").textContent =
    pct > 0 ? pct + "% lebih kecil" : "Sudah optimal";

  const url = URL.createObjectURL(compressedBlob);
  const ext = currentMode === "pdf" ? "pdf" : "jpg";
  const base = selectedFile.name.replace(/\.[^/.]+$/, "");
  const dlBtn = document.getElementById("downloadBtn");
  dlBtn.href = url;
  dlBtn.download = base + "_compressed." + ext;
  dlBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1v9M5 7l3 3 3-3" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 13v1a1 1 0 001 1h10a1 1 0 001-1v-1" stroke="white" stroke-width="1.8" stroke-linecap="round"/></svg> Unduh ${base}_compressed.${ext}`;

  document.getElementById("results-section").classList.remove("hidden");
}

function resetTool() {
  clearFile();
}

// ─── PROGRESS ─────────────────────────────────────────────────────────────────
function showProgress(label) {
  document.getElementById("progress-section").classList.remove("hidden");
  setProgress(5, label);
}
function setProgress(pct, label) {
  document.getElementById("progress-fill").style.width = pct + "%";
  document.getElementById("progress-pct").textContent = pct + "%";
  if (label) document.getElementById("progress-label").textContent = label;
}
function hideProgress() {
  document.getElementById("progress-section").classList.add("hidden");
}

// ─── ERROR ────────────────────────────────────────────────────────────────────
function showError(msg) {
  document.getElementById("error-msg").textContent = msg;
  document.getElementById("error-section").classList.remove("hidden");
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function hideAll() {
  [
    "progress-section",
    "results-section",
    "error-section",
    "already-small",
  ].forEach((id) => document.getElementById(id).classList.add("hidden"));
}
function formatBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(2) + " MB";
}

// ─── SCROLL REVEAL ────────────────────────────────────────────────────────────
const obs = new IntersectionObserver(
  (entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) e.target.classList.add("visible");
    });
  },
  { threshold: 0.1 },
);
document.querySelectorAll(".reveal").forEach((el) => obs.observe(el));
