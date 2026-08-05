- Fix 413 Nginx error : default upload size 2Mb : added a configuration into `sudo nano /etc/nginx/nginx.conf` : `http { client_max_body_size 1g; }`

