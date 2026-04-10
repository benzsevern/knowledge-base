"""Extract text from a PDF using pymupdf (no ML models needed).

Usage: extract_text.py <pdf_path> <output_dir>
Writes per-page text files and a quality score JSON to output_dir.
Prints JSON to stdout: {pages: [{page, text, chars, confident}]}
"""
import sys
import os
import json
import re
import fitz  # pymupdf


def score_page(text: str) -> dict:
    """Heuristic quality score for extracted text."""
    chars = len(text.strip())
    words = len(text.split())
    non_ascii = sum(1 for c in text if ord(c) > 127)
    non_ascii_ratio = non_ascii / max(chars, 1)

    # Detect garbled output
    garbled_pattern = len(re.findall(r'[^\x20-\x7E\n\t\r]', text))
    garbled_ratio = garbled_pattern / max(chars, 1)

    # Detect if this is mostly a figure/image page (very little text)
    too_short = chars < 100

    # Detect poorly extracted tables (lots of whitespace runs)
    whitespace_runs = len(re.findall(r' {4,}', text))
    table_heuristic = whitespace_runs > 10 and words < 50

    confident = (
        not too_short
        and garbled_ratio < 0.15
        and non_ascii_ratio < 0.3
        and not table_heuristic
    )

    return {
        "chars": chars,
        "words": words,
        "garbled_ratio": round(garbled_ratio, 3),
        "confident": confident,
    }


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: extract_text.py <pdf> <out_dir>", file=sys.stderr)
        return 2

    pdf_path, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    doc = fitz.open(pdf_path)
    pages = []
    try:
        for i, page in enumerate(doc, start=1):
            text = page.get_text("text")
            score = score_page(text)

            page_file = os.path.join(out_dir, f"page-{i:03d}.txt")
            with open(page_file, "w", encoding="utf-8") as f:
                f.write(text)

            pages.append({
                "page": i,
                "path": page_file,
                "text_length": score["chars"],
                "confident": score["confident"],
                "garbled_ratio": score["garbled_ratio"],
            })
    finally:
        doc.close()

    result = {
        "total_pages": len(pages),
        "confident_pages": sum(1 for p in pages if p["confident"]),
        "uncertain_pages": sum(1 for p in pages if not p["confident"]),
        "pages": pages,
    }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
