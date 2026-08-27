export interface ListedStorageObject {
  readonly key?: string;
  readonly name: string;
}

export const listedStorageKey = (listPrefix: string, object: ListedStorageObject): string => {
  if (object.key !== undefined && object.key.length > 0) {
    return object.key;
  }
  const name = object.name.replace(/^\/+/u, '');
  return name.startsWith(listPrefix) ? name : `${listPrefix}${name}`;
};
