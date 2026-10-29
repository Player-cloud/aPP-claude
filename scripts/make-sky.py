# Usage: python3 scripts/make-sky.py src/renderer/styles/sky
# Generates the day and night sky backdrops for the app (M16 D). Procedural, so
# the images are ours: fractal noise clouds, heavier at the edges and bottom,
# with a clear middle where the work sits.
import sys
import numpy as np
from PIL import Image, ImageFilter

W, H = 1920, 1200
rng = np.random.default_rng(7)


def value_noise(w, h, cell):
    gw, gh = w // cell + 2, h // cell + 2
    grid = rng.random((gh, gw)).astype(np.float32)
    img = Image.fromarray((grid * 255).astype(np.uint8)).resize((gw * cell, gh * cell), Image.BICUBIC)
    return np.asarray(img, dtype=np.float32)[:h, :w] / 255.0


def fbm(w, h, base=420, octaves=6):
    out = np.zeros((h, w), np.float32)
    amp, total = 1.0, 0.0
    cell = base
    for _ in range(octaves):
        out += amp * value_noise(w, h, max(2, int(cell)))
        total += amp
        amp *= 0.52
        cell /= 2.05
    return out / total


y, x = np.mgrid[0:H, 0:W].astype(np.float32)
nx, ny = x / W, y / H
# Clouds gather at the sides and bottom; the middle stays clear.
edge = np.clip(np.abs(nx - 0.5) * 2.0, 0, 1) ** 1.6
bottom = np.clip((ny - 0.35) / 0.65, 0, 1) ** 1.4
mask = np.clip(0.5 * edge + 0.5 * bottom - 0.08, 0, 1)

n = fbm(W, H)
detail = fbm(W, H, base=90, octaves=4)
density = np.clip((n * 0.9 + detail * 0.4 + mask * 0.7 - 0.86) * 2.6, 0, 0.97) ** 0.85
# Light from above: tops bright, undersides shaded.
shade = np.clip(1.0 - (np.roll(density, -14, axis=0) - density) * 1.8, 0.55, 1.0)


def lerp(a, b, t):
    return a + (b - a) * t[..., None]


def save(rgb, path):
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))
    img.save(path, quality=80, method=6)


out = sys.argv[1]

# Day
top, low = np.array([46, 112, 214], np.float32), np.array([170, 206, 244], np.float32)
sky = lerp(top, low, ny ** 0.9)
cloud_lit, cloud_dark = np.array([255, 255, 255], np.float32), np.array([176, 196, 224], np.float32)
cloud = lerp(cloud_dark, cloud_lit, shade)
day = lerp(sky, np.zeros_like(sky), np.zeros_like(ny)) * (1 - density[..., None]) + cloud * density[..., None]
save(day, f'{out}/sky-day.webp')

# Night
top, low = np.array([8, 14, 34], np.float32), np.array([30, 46, 92], np.float32)
sky = lerp(top, low, ny ** 1.1)
stars = (rng.random((H, W)) > 0.9993).astype(np.float32) * rng.uniform(120, 255, (H, W)).astype(np.float32)
stars *= (1 - density) * (1 - ny)
sky = sky + stars[..., None]
cloud_lit, cloud_dark = np.array([150, 170, 210], np.float32), np.array([28, 40, 76], np.float32)
cloud = lerp(cloud_dark, cloud_lit, (shade - 0.55) / 0.45 * 0.8)
night = sky * (1 - density[..., None] * 0.92) + cloud * (density[..., None] * 0.92)
save(night, f'{out}/sky-night.webp')
