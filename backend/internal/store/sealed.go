package store

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"sync/atomic"

	"gorm.io/gorm/schema"
)

// ErrNoSealKey means a sealed field was read or written without CALENDAR_ENC_KEY set.
var ErrNoSealKey = errors.New("CALENDAR_ENC_KEY is not set, so calendar tokens can't be encrypted or decrypted")

var sealKey atomic.Pointer[cipher.AEAD]

// SetSealKey installs the AES-256 key that sealed fields use, from 64 hex characters
// (openssl rand -hex 32). An empty string removes it.
func SetSealKey(hexKey string) error {
	if hexKey == "" {
		sealKey.Store(nil)
		return nil
	}
	key, err := hex.DecodeString(hexKey)
	if err != nil || len(key) != 32 {
		return errors.New("CALENDAR_ENC_KEY must be 32 bytes as 64 hex characters (openssl rand -hex 32)")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	sealKey.Store(&aead)
	return nil
}

// HasSealKey reports whether a key is installed.
func HasSealKey() bool { return sealKey.Load() != nil }

func init() {
	schema.RegisterSerializer("sealed", SealedSerializer{})
}

// SealedSerializer implements gorm/schema.SerializerInterface for []byte fields tagged
// gorm:"serializer:sealed". Value() seals with a random 12-byte nonce, prefixed to the
// ciphertext; Scan() opens it. The column name is the additional data, so a ciphertext
// copied from one column into another fails to open. Because it lives in the model,
// encryption is not something a future handler can forget.
type SealedSerializer struct{}

func (SealedSerializer) Value(_ context.Context, field *schema.Field, _ reflect.Value, fieldValue any) (any, error) {
	plain, ok := fieldValue.([]byte)
	if !ok {
		return nil, fmt.Errorf("sealed: %s must be []byte", field.Name)
	}
	if len(plain) == 0 {
		return []byte{}, nil // nothing to protect: the demo account has no tokens, and needs no key
	}
	aead := sealKey.Load()
	if aead == nil {
		return nil, ErrNoSealKey
	}
	nonce := make([]byte, (*aead).NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return (*aead).Seal(nonce, nonce, plain, []byte(field.DBName)), nil
}

func (SealedSerializer) Scan(ctx context.Context, field *schema.Field, dst reflect.Value, dbValue any) error {
	var sealed []byte
	switch v := dbValue.(type) {
	case nil:
	case []byte:
		sealed = v
	case string:
		sealed = []byte(v)
	default:
		return fmt.Errorf("sealed: unexpected %T in %s", dbValue, field.DBName)
	}
	var plain []byte
	if len(sealed) > 0 {
		aead := sealKey.Load()
		if aead == nil {
			return ErrNoSealKey
		}
		size := (*aead).NonceSize()
		if len(sealed) < size {
			return fmt.Errorf("sealed: %s is too short to be a ciphertext", field.DBName)
		}
		var err error
		// Never wrap err with the input: the error must not carry token material.
		if plain, err = (*aead).Open(nil, sealed[:size], sealed[size:], []byte(field.DBName)); err != nil {
			return fmt.Errorf("sealed: %s could not be decrypted (wrong CALENDAR_ENC_KEY?)", field.DBName)
		}
	}
	field.ReflectValueOf(ctx, dst).SetBytes(plain)
	return nil
}
