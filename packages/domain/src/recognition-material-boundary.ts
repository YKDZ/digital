/** 领域只比较观察范围与材料引用，不解释文件系统路径或访问权限。 */
export type RecognitionMaterialBoundary =
  | {
      readonly kind: "directory";
      readonly scopeReference: string;
      readonly directoryReference: string;
    }
  | {
      readonly kind: "discrete";
      readonly scopeReference: string;
      readonly materialReferences: readonly string[];
    };

export function validateRecognitionMaterialBoundaries(
  boundaries: readonly RecognitionMaterialBoundary[],
): void {
  if (!Array.isArray(boundaries)) throw new Error("识别材料范围必须明确声明");
  const keys = new Set<string>();
  for (const boundary of boundaries) {
    if (
      !boundary.scopeReference ||
      (boundary.kind !== "directory" && boundary.kind !== "discrete") ||
      (boundary.kind === "directory" && !boundary.directoryReference) ||
      (boundary.kind === "discrete" &&
        (boundary.materialReferences.length === 0 ||
          boundary.materialReferences.some((reference: string) => !reference) ||
          new Set(boundary.materialReferences).size !==
            boundary.materialReferences.length))
    )
      throw new Error("识别材料范围缺少有效且唯一的引用");
    const key = recognitionMaterialBoundaryKey(boundary);
    if (keys.has(key)) throw new Error("识别材料范围不能重复");
    keys.add(key);
  }
}

export function recognitionMaterialBoundaryKey(
  boundary: RecognitionMaterialBoundary,
): string {
  return JSON.stringify([
    boundary.scopeReference,
    boundary.kind,
    boundary.kind === "directory"
      ? boundary.directoryReference
      : [...boundary.materialReferences].toSorted(),
  ]);
}

export function sameRecognitionMaterialBoundaries(
  left: readonly RecognitionMaterialBoundary[],
  right: readonly RecognitionMaterialBoundary[],
): boolean {
  return (
    JSON.stringify(left.map(recognitionMaterialBoundaryKey).toSorted()) ===
    JSON.stringify(right.map(recognitionMaterialBoundaryKey).toSorted())
  );
}
