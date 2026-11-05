#!/usr/bin/env python3
"""Generate a course-assistant AppIcon.icns iconset using Pillow."""
import os
import sys

from PIL import Image, ImageDraw

SIZES = [16, 32, 64, 128, 256, 512, 1024]


def draw_icon(size):
    scale = size / 1024.0
    image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    margin = int(40 * scale)
    radius = int(180 * scale)
    # Background
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=radius,
        fill=(37, 99, 235, 255),
    )
    # Soft highlight
    draw.rounded_rectangle(
        [margin + int(20 * scale), margin + int(20 * scale), size - margin - int(20 * scale), size // 2],
        radius=max(1, radius - int(20 * scale)),
        fill=(59, 130, 246, 90),
    )
    # Book pages
    left = int(230 * scale)
    right = int(794 * scale)
    top = int(300 * scale)
    bottom = int(735 * scale)
    draw.rounded_rectangle([left, top, right, bottom], radius=int(34 * scale), fill=(255, 255, 255, 245))
    draw.line([int(512 * scale), top + int(20 * scale), int(512 * scale), bottom - int(20 * scale)], fill=(219, 234, 254, 255), width=max(2, int(8 * scale)))
    for offset in (70, 145, 220):
        y = top + int(offset * scale)
        draw.line([left + int(55 * scale), y, int(470 * scale), y], fill=(191, 219, 254, 255), width=max(2, int(14 * scale)))
        draw.line([int(554 * scale), y, right - int(55 * scale), y], fill=(191, 219, 254, 255), width=max(2, int(14 * scale)))
    # Spark
    cx, cy = int(760 * scale), int(760 * scale)
    radius_spark = int(75 * scale)
    draw.polygon(
        [
            (cx, cy - radius_spark),
            (cx + int(radius_spark * 0.28), cy - int(radius_spark * 0.28)),
            (cx + radius_spark, cy),
            (cx + int(radius_spark * 0.28), cy + int(radius_spark * 0.28)),
            (cx, cy + radius_spark),
            (cx - int(radius_spark * 0.28), cy + int(radius_spark * 0.28)),
            (cx - radius_spark, cy),
            (cx - int(radius_spark * 0.28), cy - int(radius_spark * 0.28)),
        ],
        fill=(251, 191, 36, 255),
    )
    return image


def main(outdir):
    os.makedirs(outdir, exist_ok=True)
    for size in SIZES:
        draw_icon(size).save(os.path.join(outdir, f'icon_{size}.png'))
    print('OK', outdir)


if __name__ == '__main__':
    main(sys.argv[1])
