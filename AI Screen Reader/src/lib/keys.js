/**
 * Read-a-Laud — embedded API key store.
 *
 * The key is split into three segments, each XOR-encoded with a different
 * base so that no single file ever contains the plaintext key string.
 * Users can still override with their own key via the Advanced settings.
 *
 * How to re-encode a new key (run once in Node / PowerShell, then delete helper):
 *
 *   $key = "YOUR_FISH_AUDIO_KEY"
 *   $len = $key.Length; $a3 = [Math]::Floor($len / 3)
 *   function Encode-Seg($s, [int]$xb) {
 *     $r=@(); for($i=0;$i-lt$s.Length;$i++){ $r+=([int][char]$s[$i]) -bxor (($xb+$i*7) -band 0xFF) }
 *     return ($r -join ',') }
 *   Encode-Seg $key.Substring(0,$a3)       0x4A   # paste as SEG_A
 *   Encode-Seg $key.Substring($a3,$a3)     0x7E   # paste as SEG_B
 *   Encode-Seg $key.Substring($a3*2)       0x3B   # paste as SEG_C
 */

const ENCODED = true;

/* eslint-disable */
const SEG_A = '57,58,117,57,15,30,28,86,193,220,242,198,179,212,214,252,213';
const SEG_B = '27,205,185,193,192,198,220,253,215,203,182,253,132,244,170,165,136';
const SEG_C = '67,10,48,59,0,1,20,91,75,59,238,219,213,198,204,253,238';
/* eslint-enable */

function decode(encoded, xorBase) {
  if (!encoded) return '';
  return encoded.split(',')
    .map((n, i) => String.fromCharCode(parseInt(n, 10) ^ ((xorBase + i * 7) & 0xff)))
    .join('');
}

/**
 * Return the embedded Fish Audio API key.
 * Returns '' if ENCODED is false (dev mode / placeholder not yet set).
 * The service worker uses this as a fallback when no user key is configured.
 */
export function getEmbeddedKey() {
  if (!ENCODED) return '';
  try {
    return decode(SEG_A, 0x4A) + decode(SEG_B, 0x7E) + decode(SEG_C, 0x3B);
  } catch {
    return '';
  }
}
