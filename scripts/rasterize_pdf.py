"""Rasterize a PDF to PNG pages using pymupdf. No torch, no models.

Usage: rasterize_pdf.py <pdf_path> <output_dir> [--dpi 200]
Writes page-001.png, page-002.png, ... into <output_dir> and prints
the list of produced paths (one per line) on stdout.
"""
import sys
import os
import fitz  # pymupdf


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 2:
        print("usage: rasterize_pdf.py <pdf> <out_dir> [--dpi N]", file=sys.stderr)
        return 2

    pdf_path, out_dir = args[0], args[1]
    dpi = 200
    if "--dpi" in args:
        dpi = int(args[args.index("--dpi") + 1])

    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    try:
        zoom = dpi / 72
        matrix = fitz.Matrix(zoom, zoom)
        for i, page in enumerate(doc, start=1):
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            path = os.path.join(out_dir, f"page-{i:03d}.png")
            pix.save(path)
            print(path)
    finally:
        doc.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
