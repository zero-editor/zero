#!/usr/bin/env python3
"""Draws every icon this app ships, from the numbers up.

    python3 src-tauri/icons/zero-icon.py

Two icons come out of it, because macOS is in the middle of changing what an
app icon is.

On macOS 26 the system composes the icon: it supplies the rounded rectangle,
the material, the shadow and the dark, tinted and clear variants, and asks the
app only for the mark and a background colour. That's `AppIcon.icon`, an Icon
Composer bundle — a JSON file and a transparent PNG — which the Tauri bundler
compiles into an `Assets.car` with `actool`.

Everything before macOS 26 wants the whole picture drawn for it, shadow and
all, in an `.icns`. Apple's grid for that is an 824px square inside a 1024px
canvas: 100px of air on every side, which is where the shadow lives. The
silhouette is a rounded rectangle with *continuous* corners — the curve starts
earlier and lands flatter than a circular one — and Apple publishes it as a
template rather than a formula, so CORNER below was measured off icons already
drawn to it, at the point where each row of their alpha crosses half coverage.
It matches the system's own mask to within 750 pixels of a million, every one
of them on the antialiased edge.

Needs rsvg-convert, ImageMagick and iconutil:  brew install librsvg imagemagick
"""
import json
import os
import subprocess
import sys

W = 1024                      # the canvas every size is resampled from
BOX, INSET = 824, 100         # the square the artwork occupies, and its margin
CX = W / 2

# the top-left corner of the silhouette, from where the top edge ends to where
# the left edge begins, in the 824 square's own coordinates
CORNER = [
    (210.87,0), (152.87,4), (131.44,8), (117.74,12), (107.47,16),
    (98.96,20), (91.75,24), (85.09,28), (79.08,32), (73.47,36), (68.37,40),
    (63.47,44), (58.95,48), (54.76,52), (50.76,56), (46.95,60), (43.46,64),
    (40.35,68), (37.06,72), (34.15,76), (31.39,80), (28.53,84), (26.15,88),
    (23.74,92), (21.53,96), (19.53,100), (17.53,104), (15.61,108),
    (14.13,112), (12.52,116), (11.27,120), (10.02,124), (8.72,128),
    (7.72,132), (6.90,136), (6.19,140), (5.41,144), (4.59,148), (4.18,152),
    (3.50,156), (3.10,160), (2.58,164), (2.31,168), (1.87,172), (1.50,176),
    (1.35,180), (1.09,184), (0.69,188), (0.57,192), (0.43,196), (0.35,200),
    (0.24,204), (0.23,206),
]

# the mark, against the 824 square. The counter is narrower than the outer
# form, so the sides carry more weight than the top and bottom — which is what
# a drawn zero does and a stroked ellipse doesn't. It sits 5px high: a form
# with equal weight top and bottom reads low when it's centred by measurement.
RX, RY, SIDE, TOP, RISE = 226, 310, 68, 44, 5

# porcelain: a black zero standing on a pale plate. Inverted from the first
# icon because on macOS 27 depth is a shadow cast onto the plate, and a shadow
# on a near-black plate has nothing to fall on. Dark appearances flip it back.
PLATE, INK = "#f1f1f3", "#1d1e22"

HERE = os.path.dirname(os.path.abspath(__file__))


def silhouette():
    """the `d` of Apple's rounded rectangle, one corner mirrored into four"""
    o, b = INSET, BOX
    p = lambda px, py: f"{round(o + px, 2)},{round(o + py, 2)}"
    d = [f"M {p(CORNER[0][0], 0)}"]
    d += [f"L {p(x, y)}" for x, y in CORNER[1:]]
    d += [f"L {p(x, b - y)}" for x, y in reversed(CORNER)]
    d += [f"L {p(b - x, b - y)}" for x, y in CORNER]
    d += [f"L {p(b - x, y)}" for x, y in reversed(CORNER)]
    return " ".join(d) + " Z"


def mark(rx, ry, side, top, cy, fill="url(#ink)"):
    """the zero: an ellipse with a narrower ellipse cut out of it"""
    return (
        f'<path fill="{fill}" fill-rule="evenodd" d="'
        f"M {CX - rx},{cy} a {rx},{ry} 0 1,0 {2 * rx},0 a {rx},{ry} 0 1,0 {-2 * rx},0 Z "
        f"M {CX - rx + side},{cy} a {rx - side},{ry - top} 0 1,1 {2 * (rx - side)},0 "
        f"a {rx - side},{ry - top} 0 1,1 {-2 * (rx - side)},0 Z"
        '"/>'
    )


def legacy_svg():
    """the whole picture: plate, mark, and the shadow the mark casts on it"""
    shape, cy = silhouette(), W / 2 - RISE
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{W}" viewBox="0 0 {W} {W}">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f8f8f9"/>
      <stop offset="0.5" stop-color="#ececee"/>
      <stop offset="1" stop-color="#e2e3e6"/>
    </linearGradient>
    <linearGradient id="ink" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a2b30"/>
      <stop offset="1" stop-color="{INK}"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.6"/>
    </linearGradient>
    <clipPath id="body"><path d="{shape}"/></clipPath>
    <filter id="cast" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="12"/>
    </filter>
  </defs>
  <g clip-path="url(#body)">
    <path d="{shape}" fill="url(#ground)"/>
    <g opacity="0.3" filter="url(#cast)" transform="translate(0,14)">
      {mark(RX, RY, SIDE, TOP, cy, fill="#000000")}
    </g>
    {mark(RX, RY, SIDE, TOP, cy)}
  </g>
  <path d="{shape}" fill="none" stroke="url(#edge)" stroke-width="3"/>
</svg>"""


def layer_svg():
    """the mark alone, on the full canvas — macOS 26 draws the rest itself.
    The same proportions as above, measured against 1024 instead of 824.
    Flat, because the layer is glass and the system does its own lighting."""
    k = W / BOX
    r = lambda v: round(v * k)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{W}" viewBox="0 0 {W} {W}">
  {mark(r(RX), r(RY), r(SIDE), r(TOP), W / 2 - r(RISE), fill=INK)}
</svg>"""


def web_svg():
    """the mark alone, cropped to itself, for the launcher to wear.

    Cropped rather than centred on the full canvas so the UI can size it by
    its own height without carrying most of a square of air around with it,
    and painted flat black because the launcher uses it as a CSS mask — only
    the alpha is read, and the colour comes from the theme. Same path as the
    icons, from the same numbers: the mark is drawn once, here.
    """
    k = W / BOX
    r = lambda v: round(v * k)
    rx, ry, cy = r(RX), r(RY), W / 2 - r(RISE)
    x, y, w, h = CX - rx, cy - ry, 2 * rx, 2 * ry
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'viewBox="{x} {y} {w} {h}">'
        f"{mark(rx, ry, r(SIDE), r(TOP), cy, fill='#000')}"
        "</svg>\n"
    )


def srgb(hex_colour):
    """#rrggbb as Icon Composer writes a colour"""
    r, g, b = (int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return f"extended-srgb:{r:.5f},{g:.5f},{b:.5f},1.00000"


def render(svg, out, size=W):
    """rsvg writes no metadata, so these are byte-stable across runs"""
    src = out + ".svg"
    open(src, "w").write(svg)
    subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), src, "-o", out], check=True)
    os.remove(src)


def run(*args):
    subprocess.run(args, check=True, cwd=HERE)


WEB_MARK = os.path.join(HERE, "..", "..", "src", "assets", "mark.svg")


def main():
    os.chdir(HERE)

    # first, and on its own, because it needs none of the tools below: the
    # launcher's copy of the mark. `python3 zero-icon.py mark` stops here,
    # which is the whole of what a machine without rsvg and ImageMagick can
    # redraw — and all the frontend ever needs.
    open(WEB_MARK, "w").write(web_svg())
    print("drew src/assets/mark.svg")
    if len(sys.argv) > 1 and sys.argv[1] == "mark":
        return

    render(legacy_svg(), "flat.png")

    # macOS icons carry their own shadow — the Dock doesn't add one. Measured
    # off other icons drawn to the template: tight, and pushed down.
    run("magick", "flat.png",
        "(", "+clone", "-alpha", "extract", "-blur", "0x6",
        "-evaluate", "multiply", "0.42", "-background", "black", "-alpha", "shape", ")",
        "-compose", "dst-over", "-geometry", "+0+11", "-composite",
        "-background", "none", "-flatten", "-strip", "icon.png")
    os.remove(os.path.join(HERE, "flat.png"))

    for name, size in [("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128),
                       ("128x128@2x.png", 256), ("Square30x30Logo.png", 30),
                       ("Square44x44Logo.png", 44), ("Square71x71Logo.png", 71),
                       ("Square89x89Logo.png", 89), ("Square107x107Logo.png", 107),
                       ("Square142x142Logo.png", 142), ("Square150x150Logo.png", 150),
                       ("Square284x284Logo.png", 284), ("Square310x310Logo.png", 310),
                       ("StoreLogo.png", 50)]:
        run("magick", "icon.png", "-filter", "Lanczos", "-resize", f"{size}x{size}",
            "-strip", name)

    iconset = os.path.join(HERE, "icon.iconset")
    subprocess.run(["rm", "-rf", iconset], check=True)
    os.makedirs(iconset)
    for name, size in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64),
                       ("128x128", 128), ("128x128@2x", 256), ("256x256", 256),
                       ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)]:
        run("magick", "icon.png", "-filter", "Lanczos", "-resize", f"{size}x{size}",
            "-strip", f"icon.iconset/icon_{name}.png")
    run("iconutil", "-c", "icns", "icon.iconset", "-o", "icon.icns")
    subprocess.run(["rm", "-rf", iconset], check=True)
    # 256 is a quarter of a megabyte of uncompressed bitmap on its own, and
    # nothing on this platform reads the .ico at all
    run("magick", "icon.png", "-define", "icon:auto-resize=128,64,48,32,16",
        "-strip", "icon.ico")

    # and the layered one, for the system that would rather compose it itself.
    # Its compiled form, Assets.car, is committed next to it and is what the
    # bundler is pointed at — see compile_icon() below for why.
    assets = os.path.join(HERE, "AppIcon.icon", "Assets")
    os.makedirs(assets, exist_ok=True)
    render(layer_svg(), os.path.join(assets, "zero.png"))
    white = {"solid": "extended-srgb:1.00000,1.00000,1.00000,1.00000"}
    open(os.path.join(HERE, "AppIcon.icon", "icon.json"), "w").write(json.dumps({
        # the ground the mark sits on; the system derives the gradient from it.
        # Dark appearances get the old graphite plate, and the zero goes white
        # on it below — a black zero on a dark plate is simply not there.
        "fill-specializations": [
            {"value": {"automatic-gradient": srgb(PLATE)}},
            {"appearance": "dark", "value": {"automatic-gradient": srgb(INK)}},
        ],
        "groups": [{
            "layers": [{
                # glass is what makes it an object: its own rim of light, and
                # the shadow below lands on the plate rather than in the artwork.
                # (image-name-specializations looks like the way to swap in a
                # white zero, but Icon Composer's renderer ignores it for dark;
                # recolouring the layer is what it honours.)
                "fill-specializations": [
                    {"appearance": "dark", "value": white},
                    {"appearance": "tinted", "value": white},
                ],
                "glass": True,
                "image-name": "zero.png",
                "name": "zero",
                "position": {"scale": 1, "translation-in-points": [0, 0]},
            }],
            "shadow": {"kind": "neutral", "opacity": 0.7},
            "specular": True,
            "specular-highlight-placement": "automatic",
            "translucency": {"enabled": False, "value": 0},
        }],
        "supported-platforms": {"squares": ["macOS"]},
    }, indent=2) + "\n")
    print("drawn")
    compile_icon()


def compile_icon():
    """Compile AppIcon.icon into Assets.car, which is the file that ships.

    Tauri can do this during a build, but that puts an Apple bug on the path
    of everyone who clones this: actool's Icon Composer support crashes —
    `attempt to insert nil object from objects[0]`, somewhere inside
    selectCatalogIconComposerItemsFromCollection — and once it starts, it
    keeps crashing on every icon, including Tauri's own example, until
    something out of reach resets. Restarting ibtoold doesn't clear it, nor
    does deleting its pipes or the asset-runtime cache. A missing actool the
    bundler skips gracefully; a crashing one fails the build outright.

    So the compiled catalog is committed and the config points at it. Building
    zero needs no Xcode, and this runs only when the icon is redrawn — and if
    it's in one of its moods, it says so and leaves the committed file alone.
    """
    out = os.path.join(HERE, "build")
    subprocess.run(["rm", "-rf", out], check=True)
    os.makedirs(out)
    r = subprocess.run(["actool", os.path.join(HERE, "AppIcon.icon"), "--compile", out,
                        "--app-icon", "AppIcon", "--include-all-app-icons",
                        "--platform", "macosx", "--minimum-deployment-target", "26.0",
                        "--output-partial-info-plist", os.path.join(out, "partial.plist"),
                        "--output-format", "human-readable-text"],
                       capture_output=True, text=True)
    car = os.path.join(out, "Assets.car")
    if os.path.exists(car):
        subprocess.run(["mv", car, os.path.join(HERE, "Assets.car")], check=True)
        print("compiled Assets.car")
    else:
        print("actool didn't produce Assets.car — keeping the committed one.")
        print((r.stdout + r.stderr).strip()[:400] or "  (no output)")
    subprocess.run(["rm", "-rf", out], check=True)


if __name__ == "__main__":
    main()
