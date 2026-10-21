/** Infrastructure keeps an empty product catalogue until explicitly configured. */
export const commercialFeatureWhere = {};
export function isCommercialFeature(key: string) {
    return key.length > 0;
}
