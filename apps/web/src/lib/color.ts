const cache = new Map<string, Promise<string | null>>();

/**
 * The artwork's most characterful colour: a saturation-weighted average of its pixels,
 * so a mostly-grey frame with a red logo still glows red. Null when the image can't be read.
 */
export function artworkColor(url: string | null | undefined): Promise<string | null> {
  if (!url) return Promise.resolve(null);
  let p = cache.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = c.height = 24;
          const ctx = c.getContext("2d", { willReadFrequently: true })!;
          ctx.drawImage(img, 0, 0, 24, 24);
          const d = ctx.getImageData(0, 0, 24, 24).data;
          let r = 0, g = 0, b = 0, w = 0;
          for (let i = 0; i < d.length; i += 4) {
            const R = d[i]!, G = d[i + 1]!, B = d[i + 2]!;
            const max = Math.max(R, G, B), min = Math.min(R, G, B);
            const sat = max === 0 ? 0 : (max - min) / max;
            const weight = 0.05 + sat * sat * (max / 255);
            r += R * weight; g += G * weight; b += B * weight; w += weight;
          }
          resolve(`rgb(${Math.round(r / w)} ${Math.round(g / w)} ${Math.round(b / w)})`);
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
    cache.set(url, p);
  }
  return p;
}
