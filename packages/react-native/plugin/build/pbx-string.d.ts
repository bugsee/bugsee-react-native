/**
 * pbxproj quoted strings keep their quotes in the xcode project's object
 * model, and escapes (`\n`, `\"`, `\\`) stay as two characters. The writer
 * prints the value unchanged, so a shell script has to be stored in that
 * same shape.
 */
export declare function decodePbxString(stored: string): string;
export declare function encodePbxString(value: string): string;
