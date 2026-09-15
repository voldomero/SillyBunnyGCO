export function createAssetUrl(baseUrl, token = new URL(baseUrl).searchParams.get('v')
    ?? globalThis.window?.SillyBunnyGroupUtilities?.assetToken) {
    return path => {
        const url = new URL(path, baseUrl);
        if (token) url.searchParams.set('v', token);
        return url.href;
    };
}
