module.exports = {
  apps: [
    {
      name: "tunnel-api",
      script: "/usr/local/tunnel/api/api-server.js",
      cwd: "/usr/local/tunnel/api",
      env: {
        NODE_ENV: "production",
        PORT: "5889"
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000
    }
  ]
};
