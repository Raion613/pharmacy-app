// 画面の動きに使うばねの曲線（app.css の --spring-*）を作る。node scripts/spring-curves.js の出力を app.css の :root に貼る。
// Apple のばね（WWDC23「Animate with springs」）：剛性 (2π/d)^2、減衰比 ζ = 1 − bounce。CSS の linear() に、知覚上の長さ d の 1.25倍まで点を打つ
const spring = (d, bounce, n = 64) => {
  const w0 = (2 * Math.PI) / d, z = 1 - bounce, T = d * 1.6;
  const x = (t) => {
    if (z >= 1) return 1 - (1 + w0 * t) * Math.exp(-w0 * t);
    const wd = w0 * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + (z * w0 / wd) * Math.sin(wd * t));
  };
  const pts = Array.from({ length: n + 1 }, (_, i) => (i === n ? 1 : x((T * i) / n)).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
  return { css: `linear(${pts.join(", ")})`, seconds: T.toFixed(3) };
};
for (const [name, d, b] of [["nav", 0.45, 0], ["open", 0.5, 0.12], ["close", 0.36, 0]]) {
  const s = spring(d, b);
  console.log(`  --spring-${name}: ${s.css}; /* d=${d} bounce=${b} → ${s.seconds}s */`);
}
