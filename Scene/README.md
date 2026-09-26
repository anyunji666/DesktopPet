# 场景说明

右键菜单 → 🌄 切换场景。每个子文件夹就是一个场景，放进 `Scene/` 后点「🔁 重新扫描场景」就会出现，不用重启。

## 调整背景的大小和位置

| 操作 | 作用 |
| --- | --- |
| **Shift + 滚轮** | 缩放背景（角色大小不变，向上滚放大） |
| **Shift + 拖拽** | 移动背景 |
| **Ctrl + 滚轮** | 背景前后移动 |
| **Ctrl + 拖拽** | 绕角色旋转背景（角色和镜头不动，背景自转） |

- 单独滚轮不会有反应，不会误触。
- 调整结果按场景分别记住，下次启动自动恢复，不会改动 `scene.json`。
- 右键 → 切换场景 → **↺ 重置当前场景的位置和大小**，一键还原。
- 缩放范围 0.2 到 5 倍；只作用于 3D 模型和地面，渐变 / 图片背景不受影响。

## 文件夹结构

```
Scene/
└─ 《绝区零》地铁站/          ← 文件夹名 = 菜单里显示的场景名
   ├─ 新艾利都地铁-….pmx      ← 自动选用最大的 .pmx / .pmd / .glb / .gltf 作为本体
   ├─ 车辆.pmx               ← 其他模型默认忽略，要用就写进 scene.json 的 extras
   ├─ Tex/                   ← 贴图，按相对路径自动找到
   └─ scene.json             ← 可选，所有字段都可以省略
```

- 只有 `.blend` 的文件夹会被跳过，需要先在 Blender 里导出为 `.glb`。
- 只有 `scene.json`、没有模型，就是纯「背景 + 灯光」场景，可参考 `示例-黄昏`。

## scene.json 常用字段（全部可选）

```jsonc
{
  "displayName": "菜单里显示的名字",
  "extras": [ { "file": "车辆.pmx", "position": [30, 0, -20], "rotationY": 90 } ],

  "background": "linear-gradient(180deg, #f08a2e 0%, #ffdf8f 50%)",  // 任意 CSS 背景值
  "backgroundImage": "bg.jpg",   // 或背景图，相对场景文件夹
  "hintColor": "#463728",        // 底部提示文字颜色，深色背景时改浅

  "ground": { "color": "#e4e1dc", "radius": 150 },        // 圆形地面
  "fog": { "color": "#ffdf8f", "near": 60, "far": 130 },  // 远处渐隐，near 要大于 60
  "lights": { "ambient": { "color": "#fff1dc", "intensity": 0.85 },
              "key":     { "color": "#ffdcb0", "intensity": 1.4, "position": [-6, 6, 6] },
              "back":    { "color": "#ffd9a0", "intensity": 0.5, "position": [5, 8, -6] } },
  "camera": { "distance": 1, "height": 0 }   // 取景距离倍数 / 镜头抬高
}
```

模型的出厂默认值还有 `scale`、`position`、`rotationY`，一般用鼠标调整即可。改完 `scene.json` 后点「🔁 重新扫描场景」生效。

## 排查问题

右键 → 🔧 开发者工具（独立窗口）→ Console：`[scene]` 一行是场景模型的尺寸和顶点数等；`[shader]` 开头的是着色器编译错误。
