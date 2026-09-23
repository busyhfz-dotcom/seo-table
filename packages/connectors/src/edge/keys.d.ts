/** Types for keys.js, which the connector imports under Node and the worker imports at the edge. */
export declare const BYPASS_HEADER: string;
export declare const EDGE_HEADER: string;
export declare const MANIFEST_KEY: string;
export declare const BYPASS_KEY: string;
export declare const CACHE_BUSTER: string;
export declare function hostKey(hostname: string): string;
export declare function pathKey(url: string): string;
export declare function pageKey(url: string): Promise<string>;
export declare function redirectKey(url: string): Promise<string>;
export declare function imageKey(src: string, pageUrl: string): string;
export declare function imageStem(key: string): string;
