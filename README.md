# Landing Page Xcaret — Deploy GitHub → Hostinger

## Archivos incluidos

| Archivo | Descripción |
|---|---|
| `index.html` | Landing page (copia del sitio Xcaret). Todos los clics redirigen al sitio original. |
| `.htaccess` | Configuración de Hostinger: HTTPS, caché, seguridad |
| `.github/workflows/deploy.yml` | Auto-deploy via FTP cada vez que hagas push a `main` |

---

## Pasos para configurar (una sola vez)

### 1. Crear repositorio en GitHub
1. Ve a [github.com](https://github.com) → **New repository**
2. Ponle el nombre que quieras (ej: `xcaret-landing`)
3. Selecciona **Private** (recomendado)
4. **No** marques "Add README" (ya tienes uno)
5. Clic en **Create repository**

### 2. Subir estos archivos a GitHub
En tu terminal (o GitHub Desktop):
```bash
cd "ruta/a/esta/carpeta"
git init
git add .
git commit -m "Initial deploy"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

### 3. Agregar credenciales FTP de Hostinger como Secrets

En tu repositorio de GitHub:
1. Ve a **Settings → Secrets and variables → Actions**
2. Clic en **New repository secret** y agrega estos 3 secretos:

| Secret Name | Valor |
|---|---|
| `FTP_SERVER` | El servidor FTP de Hostinger (ej: `ftp.tudominio.com`) |
| `FTP_USERNAME` | Tu usuario FTP (ej: `u123456789`) |
| `FTP_PASSWORD` | Tu contraseña FTP |

> **¿Dónde encuentro mis datos FTP en Hostinger?**
> Panel de Hostinger → **Hosting** → tu plan → **Files → FTP Accounts**

### 4. ¡Listo! Deploy automático activo

Cada vez que hagas **push a la rama `main`**, GitHub Actions desplegará automáticamente los archivos a Hostinger vía FTP.

Puedes ver el progreso en: **GitHub → tu repo → Actions**

---

## ¿Cómo funciona el redirect?

El `index.html` contiene un script JavaScript que detecta cada clic del usuario:
- Si el clic es en un link que ya apunta a `xotics.site.gxs.travel` → lo deja pasar normalmente (el cliente va al sitio original a comprar)
- Si el clic es en un botón u otro elemento interactivo → redirige al sitio original

Así el cliente siempre termina comprando en el sitio oficial, y tú recibes tu comisión como vendedor Xcaret.
