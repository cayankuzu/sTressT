import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from "three";

type SignStyle = { width: number; height: number; background: string; color: string; accent?: string; font?: string };

/** Unlit canvas-text sign: reads like a lit shop sign without any real light or bloom cost. */
export function createSign(text: string, style: SignStyle): Mesh {
  const pxPerMetre = 256;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(style.width * pxPerMetre);
  canvas.height = Math.round(style.height * pxPerMetre);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
    const size = Math.round(canvas.height * 0.52);
    ctx.font = style.font ?? `800 ${size}px system-ui, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = style.accent ?? style.color;
    ctx.shadowBlur = 18;
    ctx.fillStyle = style.color;
    drawAccentedText(ctx, text, canvas.width / 2, canvas.height / 2 + size * 0.04, style);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const mesh = new Mesh(new PlaneGeometry(style.width, style.height), new MeshBasicMaterial({ map: texture, toneMapped: false }));
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** Characters wrapped in [brackets] are drawn in the accent colour: "s[T]ress[T]". */
function drawAccentedText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, style: SignStyle): void {
  const segments: { text: string; accent: boolean }[] = [];
  for (const part of text.split(/(\[[^\]]*\])/)) {
    if (!part) continue;
    const accent = part.startsWith("[");
    segments.push({ text: accent ? part.slice(1, -1) : part, accent });
  }
  const total = segments.reduce((w, s) => w + ctx.measureText(s.text).width, 0);
  let x = cx - total / 2;
  ctx.textAlign = "left";
  for (const s of segments) {
    ctx.fillStyle = s.accent && style.accent ? style.accent : style.color;
    ctx.fillText(s.text, x, cy);
    x += ctx.measureText(s.text).width;
  }
}
