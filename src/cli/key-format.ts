export function bytesToChars(buf: Buffer): string {
  let out = '';
  for (const b of buf) {
    if (b === 0x1b) out += '\\u001b';
    else if (b === 0x0d) out += '\\r';
    else if (b === 0x09) out += '\\t';
    else if (b === 0x0a) out += '\\n';
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += `\\u${b.toString(16).padStart(4, '0')}`;
  }
  return `"${out}"`;
}

export function bytesToDisplay(buf: Buffer): string {
  return Array.from(buf)
    .map((b) => {
      if (b === 0x1b) return 'ESC';
      if (b === 0x0d) return 'CR';
      if (b === 0x09) return 'TAB';
      if (b === 0x0a) return 'LF';
      if (b === 0x20) return 'SPC';
      if (b === 0x7f) return 'DEL';
      if (b > 0x20 && b < 0x7f) return String.fromCharCode(b);
      return `\\x${b.toString(16).padStart(2, '0')}`;
    })
    .join(' ');
}
