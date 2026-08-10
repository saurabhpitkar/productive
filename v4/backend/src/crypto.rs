pub fn encrypt_key(fernet_key: &str, plaintext: &str) -> String {
    if fernet_key.is_empty() { return plaintext.to_string(); }
    match fernet::Fernet::new(fernet_key) {
        Some(f) => f.encrypt(plaintext.as_bytes()),
        None => plaintext.to_string(),
    }
}

pub fn decrypt_key(fernet_key: &str, ciphertext: &str) -> anyhow::Result<String> {
    if fernet_key.is_empty() { return Ok(ciphertext.to_string()); }
    match fernet::Fernet::new(fernet_key) {
        Some(f) => {
            let bytes = f.decrypt(ciphertext).map_err(|_| anyhow::anyhow!("decryption failed"))?;
            Ok(String::from_utf8(bytes)?)
        }
        None => anyhow::bail!("invalid fernet key"),
    }
}
