"""把外部图片制作成 Hamster Punch 的图标。

流程：读取一张方形原图 -> 四角切圆（圆角外透明）-> 缩放出 Chrome 需要的
16 / 32 / 48 / 128 四个尺寸。

用法：
    python tools/make_icons_from_image.py [图片路径]

不传路径时使用 SOURCE 里默认的原图。
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "icons"

# 原图路径（相对项目根目录），可以换成别的图
SOURCE = ROOT / "assets" / "icon-source.png"

# 圆角半径占边长的比例，0.17 大约是常见应用图标的圆润程度
CORNER_RATIO = 0.17

# Chrome 扩展需要的尺寸
SIZES = (16, 32, 48, 128)

# 小于这个尺寸的图标需要额外锐化，否则缩太小会糊
CRISP_BELOW = 48


def rounded_master(img: Image.Image) -> Image.Image:
    """把方形图切成圆角，圆角外变成透明。

    遮罩先放大 4 倍再缩小回来，这样圆角边缘是平滑的抗锯齿。
    """
    img = img.convert("RGBA")
    side = min(img.size)
    if img.size != (side, side):  # 不是正方形就先居中裁成方的
        left = (img.width - side) // 2
        top = (img.height - side) // 2
        img = img.crop((left, top, left + side, top + side))

    radius = round(side * CORNER_RATIO)
    scale = 4
    mask = Image.new("L", (side * scale, side * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, side * scale - 1, side * scale - 1),
        radius=radius * scale,
        fill=255,
    )
    mask = mask.resize((side, side), Image.LANCZOS)

    result = img.copy()
    result.putalpha(mask)
    return result


def make_crisp(img: Image.Image) -> Image.Image:
    """小尺寸专用的清晰化：先压掉 JPEG 噪声色阶，再轻度锐化。

    直接把 256px 缩到 16px 会糊成一片；先把颜色数量压到 24 种
    让色块变“实”，再锐化边缘，小图标就能保持像素画的干脆感。
    """
    quantized = img.quantize(colors=24, method=Image.FASTOCTREE).convert("RGBA")
    return quantized.filter(ImageFilter.UnsharpMask(radius=2, percent=100, threshold=2))


def main() -> None:
    src_path = Path(sys.argv[1]) if len(sys.argv) > 1 else SOURCE
    master = rounded_master(Image.open(src_path))

    OUT_DIR.mkdir(exist_ok=True)
    master.save(OUT_DIR / "icon-master.png")

    for size in SIZES:
        src = make_crisp(master) if size < CRISP_BELOW else master
        src.resize((size, size), Image.LANCZOS).save(OUT_DIR / f"icon{size}.png")
        print(f"icons/icon{size}.png")

    # 预览：四个尺寸放大到 128 摆一排，灰色背景衬托透明圆角
    gap = 12
    strip = Image.new("RGBA", (len(SIZES) * 128 + (len(SIZES) - 1) * gap, 128), (120, 120, 120, 255))
    for i, size in enumerate(SIZES):
        icon = Image.open(OUT_DIR / f"icon{size}.png")
        strip.alpha_composite(icon.resize((128, 128), Image.NEAREST), (i * (128 + gap), 0))
    strip.save(OUT_DIR / "preview-sizes.png")
    print("icons/preview-sizes.png")


if __name__ == "__main__":
    main()
