// A small bundled list of common passwords that satisfy the 12-character minimum.
// Compared case-insensitively after trimming. Not exhaustive by design (spec §3.1).
const COMMON = new Set(
  [
    "123456789012", "1234567890123", "12345678901234", "123456123456", "111111111111",
    "000000000000", "121212121212", "123123123123", "987654321098", "112233445566",
    "aaaaaaaaaaaa", "abcdefghijkl", "abcd1234abcd", "abc123abc123", "qwertyuiopas",
    "qwertyuiop12", "qwertyuiop123", "qwerty123456", "qwerty12345678", "1q2w3e4r5t6y",
    "1qaz2wsx3edc", "zaq12wsxcde3", "asdfghjkl123", "asdfasdfasdf", "zxcvbnm12345",
    "password1234", "password12345", "password123456", "password!234", "passwordpassword",
    "password1!password", "p@ssw0rd1234", "p@ssword1234", "passw0rd1234", "mypassword123",
    "changeme1234", "changemenow!", "letmein12345", "letmeinletmein", "welcome12345",
    "welcome123456", "welcometothejungle", "iloveyou1234", "iloveyouiloveyou", "trustno1trustno1",
    "administrator", "administrator1", "admin1234567", "adminadminadmin", "rootpassword",
    "superman1234", "batman123456", "football1234", "baseball1234", "basketball12",
    "monkey123456", "dragon123456", "sunshine1234", "princess1234", "starwars1234",
    "computer1234", "internet1234", "whatever1234", "secret123456", "mysecretpassword",
    "correcthorsebatterystaple", "thequickbrownfox", "letmein123456", "default12345",
    "sitesync1234", "sitesync12345", "sitesyncadmin", "controlcentre", "controlcenter",
  ].map((entry) => entry.toLowerCase()),
);

export function isCommonPassword(password: string): boolean {
  return COMMON.has(password.trim().toLowerCase());
}
