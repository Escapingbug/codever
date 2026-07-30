declare const __CODEVER_BUILD_VERSION__: string;

export const CODEVER_BUILD_VERSION =
  typeof __CODEVER_BUILD_VERSION__ === "string"
    ? __CODEVER_BUILD_VERSION__
    : "development";
