import qrcode from "qrcode-generator";
import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";

/** Deterministic SVG QR from the signed token; no network image service. */
export function QrCode({ value, size = 248 }: { value: string; size?: number }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const parts: string[] = [];
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) if (qr.isDark(y, x)) parts.push(`M${x + 4},${y + 4}h1v1h-1z`);
    return { path: parts.join(""), count: n + 8 };
  }, [value]);
  return (
    <View
      accessibilityLabel="Rotating event pass QR code"
      style={{ backgroundColor: "white", padding: 8, borderRadius: 12, alignSelf: "center" }}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${count} ${count}`}>
        <Path d={path} fill="#111827" />
      </Svg>
    </View>
  );
}
