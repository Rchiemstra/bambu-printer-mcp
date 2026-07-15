const MODEL_ROLES = new Set([
    "Inner wall",
    "Outer wall",
    "Overhang wall",
    "Sparse infill",
    "Internal solid infill",
    "Floating vertical shell",
    "Top surface",
    "Bottom surface",
    "Ironing",
    "Bridge",
    "Gap infill",
]);
export function classifyRole(role) {
    if (role === "Support")
        return "support_body";
    if (role === "Support transition")
        return "support_transition";
    if (role === "Support interface" || role === "Support ironing")
        return "support_interface";
    if (MODEL_ROLES.has(role ?? ""))
        return "model";
    if (role === "Skirt" || role === "Brim")
        return "adhesion";
    if (role === "Prime tower")
        return "prime_tower";
    if (role === "Flush")
        return "flush";
    if (role === "Custom")
        return "custom";
    return "unknown";
}
export function isSupportCategory(category) {
    return category === "support_body" || category === "support_transition" || category === "support_interface";
}
