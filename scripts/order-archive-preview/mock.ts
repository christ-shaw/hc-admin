export const usePermission = () => ({ can: () => true });
export async function callFunction<T>(name: string, payload: unknown): Promise<T> {
 const response = await fetch("/__archive-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, payload }) });
 return response.json();
}
