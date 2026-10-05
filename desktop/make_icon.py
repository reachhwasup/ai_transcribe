"""Draw the app's icon: a 1024 px tile with a sound wave, the base every icon size is cut from."""
import sys

from PIL import Image, ImageDraw

SIZE = 1024


def draw() -> Image.Image:
    scale = 4                                     # drawn large and reduced, for smooth edges
    big = SIZE * scale
    tile = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    gradient = Image.new("RGBA", (big, big))
    pixels = ImageDraw.Draw(gradient)
    top, bottom = (59, 130, 246), (30, 27, 75)    # the app's blue, down into its dark indigo
    for y in range(big):
        t = y / big
        pixels.line([(0, y), (big, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    margin = int(big * 0.09)
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([margin, margin, big - margin, big - margin], radius=int(big * 0.19), fill=255)
    tile.paste(gradient, (0, 0), mask)
    wave = ImageDraw.Draw(tile)
    heights = [0.16, 0.30, 0.46, 0.24, 0.38, 0.20, 0.12]
    bar, gap = int(big * 0.062), int(big * 0.036)
    left = (big - (len(heights) * bar + (len(heights) - 1) * gap)) // 2
    for i, h in enumerate(heights):
        x, half = left + i * (bar + gap), int(big * h / 2)
        wave.rounded_rectangle([x, big // 2 - half, x + bar, big // 2 + half], radius=bar // 2, fill=(255, 255, 255, 240))
    return tile.resize((SIZE, SIZE), Image.LANCZOS)


if __name__ == "__main__":
    draw().save(sys.argv[1])
