// Favicon động: vẽ từng khung hình của sticker.webm lên canvas rồi đặt làm icon của tab.
// Mọi lỗi (trình duyệt không phát được video, canvas bị chặn...) đều bỏ qua: tab vẫn có icon tĩnh trong index.html.
const SIZE = 64;
const INTERVAL_MS = 150;

export function initAnimatedFavicon() {
  try {
    const link = document.getElementById("favicon");
    if (!link) return;

    const video = document.createElement("video");
    video.src = "img/sticker.webm";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;

    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let timer = null;
    const draw = () => {
      try {
        if (video.readyState < 2) return;
        const scale = Math.min(SIZE / video.videoWidth, SIZE / video.videoHeight);
        const w = video.videoWidth * scale;
        const h = video.videoHeight * scale;
        ctx.clearRect(0, 0, SIZE, SIZE);
        ctx.drawImage(video, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
        link.type = "image/png";
        link.href = canvas.toDataURL("image/png");
      } catch {
        stop();
      }
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const start = () => { if (!timer) timer = setInterval(draw, INTERVAL_MS); };

    video.addEventListener("playing", start);
    video.addEventListener("error", stop);
    video.play().catch(() => {});
  } catch { /* giữ icon tĩnh */ }
}
