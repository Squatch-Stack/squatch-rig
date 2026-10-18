// The public tree has no private devices.
export const privateDevices = { workletUrls: [], addable: [] };
export async function loadPrivateDevices() { return privateDevices; }
